"""Full-schema research export regression on verify-research-database's marked DB.

Run via OPENPBL_VERIFY_RESEARCH_EXPORT_ONLY=1 pnpm test:db:research. Direct
invocation is skipped unless the caller explicitly supplies the guarded fixture.
No production config, data, cloud upload or service state is used.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("research_backup_db", REPOSITORY / "deploy/backup/classroom-research-backup.py")
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


@unittest.skipUnless(os.environ.get("OPENPBL_RESEARCH_DB_INTEGRATION") == "1",
                     "Run the marked disposable database harness to enable integration")
class ResearchPackageDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.marker = os.environ.get("OPENPBL_VERIFICATION_MARKER", "")
        if not re.fullmatch(r"openpbl-research-check-[0-9a-f-]{36}", cls.marker):
            raise RuntimeError("A disposable database marker is required")
        cls.pg = ["docker", "exec", "-i", cls.marker, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"]
        result = subprocess.run(cls.pg, input='SELECT marker FROM "_OpenpblVerification";', text=True,
                                capture_output=True, check=True, timeout=10)
        if result.stdout.strip() != cls.marker:
            raise RuntimeError("Database marker mismatch")
        cls.fixture = json.loads(Path(os.environ["OPENPBL_RESEARCH_DB_FIXTURE"]).read_text())

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="openpbl-research-package-db-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for override in (patch.object(backup, "ROOT", self.root / "packages-root"),
                         patch.object(backup.local, "pg_args", return_value=self.pg),
                         patch.dict(os.environ, {"AI_AUDIT_OUTBOX_DIR": str(self.root / "outbox")})):
            override.start()
            self.addCleanup(override.stop)
        self.session = {"session": "isolated-formal-classroom", "offeringId": self.fixture["offeringId"]}

    def rows(self, package, table):
        return [json.loads(line) for line in (package / (table + ".jsonl")).read_text().splitlines()]

    def test_real_consistent_package_inventory_scope_pending_outbox_and_repeat_export(self):
        outbox = self.root / "outbox"
        (outbox / "quarantine").mkdir(parents=True)
        batches = [{"courseId": self.fixture["instanceId"], "eventType": "request", "content": "Synthetic pending audit"},
                   {"courseId": "excluded-other-instance", "eventType": "request", "content": "Excluded audit"}]
        (outbox / "batch.json").write_text(json.dumps(batches))
        (outbox / "quarantine/failed.json").write_text(json.dumps(batches[:1]))
        package, manifest = backup.export_package(self.session)
        self.assertEqual(backup.verify_package(package), manifest)
        self.assertEqual(manifest["formatVersion"], 1)
        self.assertFalse(manifest["fullSystemRecovery"])
        self.assertEqual(manifest["pendingTasks"], 1)
        self.assertEqual(manifest["pendingAuditBatches"], 2)
        self.assertEqual(manifest["quarantinedAuditBatches"], 1)
        self.assertTrue(manifest["snapshot"]["snapshot"])
        self.assertEqual(manifest["diagnostics"]["issues"]["researchKeyMismatch"], 1)
        self.assertEqual(manifest["diagnostics"]["issues"]["messageReferenceUnresolved"], 1)
        self.assertTrue(manifest["diagnostics"]["countsAreNotGrades"])
        for table, inventory in manifest["files"].items():
            self.assertEqual(inventory["records"], len(self.rows(package, table.removesuffix(".jsonl"))))
        self.assertEqual({row["id"] for row in self.rows(package, "AiConversation")}, set(self.fixture["conversations"]))
        self.assertEqual({row["id"] for row in self.rows(package, "AiMessage")}, set(self.fixture["messages"]))
        self.assertEqual({row["id"] for row in self.rows(package, "AiTask")}, {"export-pending", "export-null-offering-task"})
        self.assertEqual({row["id"] for row in self.rows(package, "ActivitySubmission")}, {"export-submission"})
        self.assertEqual({row["id"] for row in self.rows(package, "ClassroomInstance")}, {self.fixture["instanceId"]})
        self.assertIn(self.fixture["userId"], {row["id"] for row in self.rows(package, "User")})
        self.assertNotIn(self.fixture["otherUserId"], {row["id"] for row in self.rows(package, "User")})
        self.assertTrue(all(event["courseId"] == self.fixture["instanceId"] for batch in self.rows(package, "AuditOutbox") for event in batch["events"]))
        same_package, same = backup.export_package(self.session)
        self.assertEqual(same_package, package)
        self.assertEqual(same["dataDigest"], manifest["dataDigest"])
        self.assertEqual(len(list(package.parent.iterdir())), 1)
        other_session = {**self.session, "session": "isolated-second-classroom"}
        other_package, other_manifest = backup.export_package(other_session)
        self.assertEqual(other_manifest["dataDigest"], manifest["dataDigest"])
        self.assertNotEqual(other_package, package)
        self.assertEqual(other_manifest["session"], other_session["session"])
        self.assertEqual(backup.verify_package(package)["session"], self.session["session"])
        self.assertEqual(package.parent.name, self.session["session"])
        self.assertEqual(other_package.parent.name, other_session["session"])
        subprocess.run([*self.pg, "-v", "offering=" + self.fixture["offeringId"]], input='''INSERT INTO "DomainEvent" (id,"idempotencyKey","offeringId","eventType")
            VALUES ('export-late-domain','export-late-domain',:'offering','synthetic-late-fact');''',
            text=True, capture_output=True, check=True, timeout=10)
        changed_package, changed = backup.export_package(self.session)
        self.assertNotEqual(changed["dataDigest"], manifest["dataDigest"])
        self.assertEqual((changed_package / "AiMessage.jsonl").stat().st_ino, (package / "AiMessage.jsonl").stat().st_ino)
        self.assertEqual(self.rows(package, "DomainEvent"), [])
        self.assertEqual([row["id"] for row in self.rows(changed_package, "DomainEvent")], ["export-late-domain"])
        backup.verify_package(package)
        backup.verify_package(changed_package)
        print("PASS real repeatable-read package, inventory, offering scope, historical AI, pending work, outbox, diagnoses, session-isolated reuse and unchanged-table hardlinks")

    def test_actual_exported_file_corruption_is_rejected(self):
        package, _ = backup.export_package(self.session)
        message_file = package / "AiMessage.jsonl"
        original = message_file.read_bytes()
        message_file.write_bytes(original.replace(b"Synthetic", b"Corrupted", 1))
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_package(package)
        message_file.write_bytes(original)
        backup.verify_package(package)
        print("PASS actual exported research file corruption detection and verified reread")


if __name__ == "__main__":
    unittest.main()
