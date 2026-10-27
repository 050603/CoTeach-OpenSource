"""Research archive integrity, failure recovery and classroom sealing boundaries."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("classroom_backup", REPOSITORY / "deploy/backup/classroom-research-backup.py")
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
OFFERING = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"


class ClassroomResearchBackupTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for attribute, value in (("ROOT", self.root / "research"), ("PROJECT", self.root / "project")):
            replacement = patch.object(backup, attribute, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        replacement = patch.object(backup.local, "ROOT", self.root / "local")
        replacement.start()
        self.addCleanup(replacement.stop)
        self.session = {"session": "formal-2026-10-20", "offeringId": OFFERING,
                        "protectionStartEpoch": 1000, "sealAfterEpoch": 2000, "deadlineEpoch": 3000}

    def package(self, name="fixture", classrooms=1, pending=0):
        target = backup.ROOT / "packages" / name
        target.mkdir(parents=True)
        rows = {table: [] for table in backup.selectors(OFFERING)}
        rows.update(CourseOffering=[{"id": OFFERING}], AiMessage=[{"id": "message", "content": "完整研究消息"}],
                    ClassroomInstance=[{"id": "instance"}] if classrooms else [], AuditOutbox=[])
        files = {}
        counts = {}
        for table, records in rows.items():
            path = target / (table + ".jsonl")
            path.write_text("".join(backup.canonical(row) + "\n" for row in records))
            counts[table] = len(records)
            files[path.name] = {"sha256": backup.local.sha256(path), "bytes": path.stat().st_size, "records": len(records)}
        manifest = {"formatVersion": 1, "kind": "scoped-classroom-research", "offeringId": OFFERING,
                    "session": self.session["session"], "snapshot": {"at": "2026-10-20T09:00:00Z"},
                    "files": files, "counts": counts, "pendingTasks": pending, "pendingAuditBatches": 0,
                    "dataDigest": hashlib.sha256(backup.canonical(files).encode()).hexdigest()}
        backup.write_json(target / "manifest.json", manifest)
        return target, manifest

    def state_path(self, kind="session"):
        return backup.ROOT / "status" / (self.session["session"] + "-" + kind + ".json")

    def test_manifest_verification_detects_changed_bytes_inventory_counts_and_digest(self):
        target, manifest = self.package()
        self.assertEqual(backup.verify_package(target), manifest)
        message = target / "AiMessage.jsonl"
        original = message.read_bytes()
        message.write_bytes(original.replace(b"message", b"changed"))
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_package(target)
        message.write_bytes(original)
        extra = target / "unexpected.jsonl"
        extra.write_text("{}\n")
        with self.assertRaisesRegex(RuntimeError, "Unexpected archive files"):
            backup.verify_package(target)
        extra.unlink()
        manifest["counts"]["AiMessage"] = 2
        backup.write_json(target / "manifest.json", manifest)
        with self.assertRaisesRegex(RuntimeError, "record count mismatch"):
            backup.verify_package(target)
        manifest["counts"]["AiMessage"] = 1
        manifest["dataDigest"] = "0" * 64
        backup.write_json(target / "manifest.json", manifest)
        with self.assertRaisesRegex(RuntimeError, "archive digest mismatch"):
            backup.verify_package(target)

    def test_export_uses_one_read_only_transaction_and_reuses_the_original_snapshot_manifest(self):
        queries = []
        timestamps = iter(("2026-10-20T09:00:00Z", "2026-10-20T09:05:00Z"))

        def process(_arguments, **kwargs):
            queries.append(kwargs["stdin"].read())
            records = [("_snapshot", {"at": next(timestamps), "snapshot": "1:2:"}),
                       ("CourseOffering", {"id": OFFERING}), ("ClassroomInstance", {"id": "formal-instance"})]
            return SimpleNamespace(stdout=iter(backup.canonical({"table": table, "row": row}) + "\n" for table, row in records),
                                   wait=lambda: 0, poll=lambda: 0)

        audit = [(False, "batch.json", [{"courseId": "formal-instance", "content": "formal evidence"},
                                       {"courseId": "other-instance", "content": "excluded evidence"}])]
        with patch.object(backup.subprocess, "Popen", side_effect=process), \
                patch.object(backup, "capture_outbox", return_value=audit):
            first_path, first = backup.export_package(self.session)
            second_path, second = backup.export_package(self.session)
        self.assertEqual(first_path, second_path)
        self.assertEqual(first, second)
        self.assertEqual(second["snapshot"]["at"], "2026-10-20T09:00:00Z")
        self.assertEqual(backup.verify_package(second_path), second)
        self.assertEqual(len(list((backup.ROOT / "packages").iterdir())), 1)
        retained_audit = json.loads((first_path / "AuditOutbox.jsonl").read_text())
        self.assertEqual([event["courseId"] for event in retained_audit["events"]], ["formal-instance"])
        for query in queries:
            self.assertEqual(query.count("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"), 1)
            self.assertTrue(query.endswith("COMMIT;\n"))
            self.assertIn("ORDER BY to_jsonb(t)->>'id',to_jsonb(t)::text", query)

    def test_archive_refuses_missing_table_and_symlinked_evidence(self):
        target, manifest = self.package()
        removed = manifest["files"].pop("AiMessage.jsonl")
        backup.write_json(target / "manifest.json", manifest)
        with self.assertRaisesRegex(RuntimeError, "inventory mismatch"):
            backup.verify_package(target)
        manifest["files"]["AiMessage.jsonl"] = removed
        backup.write_json(target / "manifest.json", manifest)
        source = target / "AiMessage.jsonl"
        outside = self.root / "outside.jsonl"
        source.rename(outside)
        source.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_package(target)

    def test_cloud_authentication_failure_never_initializes_or_acknowledges_a_snapshot(self):
        target, manifest = self.package()
        previous = {"snapshotId": "previous", "dataDigest": "prior", "readbackVerified": True}
        backup.write_json(self.state_path("cloud"), previous)
        with patch.object(backup, "restic", side_effect=RuntimeError("Repository access denied")) as restic:
            with self.assertRaisesRegex(RuntimeError, "access denied"):
                backup.upload_package(self.session, target, manifest)
        self.assertEqual(restic.call_args_list[0].args[0], ["snapshots", "--json"])
        self.assertEqual(restic.call_count, 1)
        self.assertEqual(json.loads(self.state_path("cloud").read_text()), previous)
        self.assertTrue(target.is_dir())

    def test_explicit_repository_init_distinguishes_missing_from_auth_or_network_failure(self):
        for exit_code in (1, 11, 12):
            with self.subTest(exit_code=exit_code), \
                    patch.object(backup.sys, "argv", ["classroom-research-backup.py", "init-repository"]), \
                    patch.object(backup, "restic", return_value=subprocess.CompletedProcess([], exit_code, "")) as restic:
                with self.assertRaisesRegex(RuntimeError, "not initializing"):
                    backup.main()
                self.assertEqual(restic.call_count, 1)
        with patch.object(backup.sys, "argv", ["classroom-research-backup.py", "init-repository"]), \
                patch.object(backup, "restic", side_effect=[subprocess.CompletedProcess([], 10, ""),
                                                           subprocess.CompletedProcess([], 0, "")]) as restic, \
                patch("builtins.print"):
            backup.main()
        self.assertEqual(restic.call_args_list[1].args[0][0], "init")

    def test_failed_upload_preserves_previous_receipt_and_package_for_retry(self):
        target, manifest = self.package()
        previous = {"snapshotId": "previous", "dataDigest": "old", "readbackVerified": True}
        backup.write_json(self.state_path("cloud"), previous)
        with patch.object(backup, "restic", side_effect=[subprocess.CompletedProcess([], 0, "[]"),
                                                        RuntimeError("Upload connection failed")]) as restic:
            with self.assertRaisesRegex(RuntimeError, "connection failed"):
                backup.upload_package(self.session, target, manifest)
        self.assertEqual(restic.call_count, 2)
        self.assertEqual(json.loads(self.state_path("cloud").read_text()), previous)
        self.assertEqual(backup.verify_package(target), manifest)

    def test_same_digest_skips_cloud_only_after_successful_readback(self):
        target, manifest = self.package()
        previous = {"snapshotId": "verified", "dataDigest": manifest["dataDigest"], "readbackVerified": True}
        backup.write_json(self.state_path("cloud"), previous)
        with patch.object(backup, "restic") as restic:
            self.assertEqual(backup.upload_package(self.session, target, manifest), previous)
            restic.assert_not_called()
        previous["readbackVerified"] = False
        backup.write_json(self.state_path("cloud"), previous)
        with patch.object(backup, "restic", side_effect=RuntimeError("must retry")) as restic:
            with self.assertRaisesRegex(RuntimeError, "must retry"):
                backup.upload_package(self.session, target, manifest)
            restic.assert_called_once()

    def test_cloud_receipt_is_acknowledged_only_after_actual_download_verification(self):
        target, manifest = self.package()
        snapshot_id = "abcdef0123456789"

        def restic(arguments, package=None):
            if arguments[0] == "backup":
                return subprocess.CompletedProcess([], 0, json.dumps({"message_type": "summary", "snapshot_id": snapshot_id}))
            if arguments[0] == "restore":
                shutil.copytree(target, backup.ROOT / "readback" / snapshot_id / "payload")
            return subprocess.CompletedProcess([], 0, "[]")

        with patch.object(backup, "restic", side_effect=restic):
            receipt = backup.upload_package(self.session, target, manifest)
        self.assertTrue(receipt["readbackVerified"])
        self.assertEqual(receipt["dataDigest"], manifest["dataDigest"])
        self.assertEqual(json.loads(self.state_path("cloud").read_text()), receipt)
        self.assertFalse((backup.ROOT / "readback" / snapshot_id).exists())

    def test_corrupt_download_does_not_replace_the_last_verified_cloud_receipt(self):
        target, manifest = self.package()
        previous = {"snapshotId": "previous", "dataDigest": "old", "readbackVerified": True}
        backup.write_json(self.state_path("cloud"), previous)
        snapshot_id = "abcdef0123456789"

        def restic(arguments, package=None):
            if arguments[0] == "backup":
                return subprocess.CompletedProcess([], 0, json.dumps({"message_type": "summary", "snapshot_id": snapshot_id}))
            if arguments[0] == "restore":
                restored = backup.ROOT / "readback" / snapshot_id / "payload"
                shutil.copytree(target, restored)
                (restored / "AiMessage.jsonl").write_text('{"id":"corrupt"}\n')
            return subprocess.CompletedProcess([], 0, "[]")

        with patch.object(backup, "restic", side_effect=restic):
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                backup.upload_package(self.session, target, manifest)
        self.assertEqual(json.loads(self.state_path("cloud").read_text()), previous)
        self.assertEqual(backup.verify_package(target), manifest)

    def tick(self, now, manifest, after=None, upload_error=None, busy=False):
        package = backup.ROOT / "packages/observed"
        package.mkdir(parents=True, exist_ok=True)

        def local_command(command, **_kwargs):
            if command[2] == "backup":
                backup.write_json(backup.local.ROOT / "status/last-success.json", {
                    "startedEpoch": now - 1 if busy else now, "snapshot": "final-local"})
            return subprocess.CompletedProcess(command, 0, "")

        with patch.object(backup.time, "time", return_value=now), \
                patch.object(backup, "export_package", side_effect=[(package, manifest), (package, after or manifest)]), \
                patch.object(backup, "upload_package", side_effect=upload_error, return_value={"readbackVerified": True}) as upload, \
                patch.object(backup.subprocess, "run", side_effect=local_command) as local_command_mock:
            state = backup.session_tick(self.session, now=now)
        return state, upload, local_command_mock

    def test_two_stable_observations_seal_and_busy_local_backup_retries(self):
        _, manifest = self.package()
        first, _, commands = self.tick(2000, manifest)
        self.assertEqual(first["state"], "protecting")
        commands.assert_not_called()
        second, _, commands = self.tick(2300, manifest, busy=True)
        self.assertEqual(second["state"], "protecting")
        self.assertIn("lock busy", second["reason"])
        self.assertEqual(commands.call_count, 1)
        third, _, commands = self.tick(2600, manifest)
        self.assertEqual(third["state"], "sealed")
        self.assertEqual(third["localSnapshot"], "final-local")
        self.assertEqual(commands.call_args_list[-1].args[0][2], "seal")
        self.assertIn("only server-received", third["browserUnsentData"])

    def test_preclass_stability_does_not_replace_two_postclass_observations(self):
        _, manifest = self.package()
        self.tick(1500, manifest)
        self.tick(1800, manifest)
        first, _, commands = self.tick(2000, manifest)
        self.assertEqual(first["state"], "protecting")
        commands.assert_not_called()
        second, _, commands = self.tick(2300, manifest)
        self.assertEqual(second["state"], "sealed")
        self.assertEqual(commands.call_count, 2)

    def test_pending_tasks_audit_batches_or_no_classroom_prevent_final_seal(self):
        _, manifest = self.package()
        for field in ("pendingTasks", "pendingAuditBatches"):
            with self.subTest(field=field):
                pending = {**manifest, field: 1}
                self.tick(2000, pending)
                state, _, commands = self.tick(2300, pending)
                self.assertEqual(state["state"], "protecting")
                self.assertEqual(state["pending"], 1)
                commands.assert_not_called()
        self.state_path().unlink()
        empty = {**manifest, "counts": {**manifest["counts"], "ClassroomInstance": 0}}
        self.tick(2000, empty)
        state, _, commands = self.tick(2300, empty)
        self.assertIn("No formal classroom", state["reason"])
        commands.assert_not_called()

    def test_late_data_invalidates_local_finalization_and_restarts_stability_wait(self):
        _, manifest = self.package()
        self.tick(2000, manifest)
        late = {**manifest, "dataDigest": "late-content"}
        state, _, commands = self.tick(2300, manifest, after=late)
        self.assertEqual(state["state"], "protecting")
        self.assertIn("Late data", state["reason"])
        self.assertEqual(commands.call_count, 1)
        state, _, commands = self.tick(2500, late)
        self.assertEqual(state["state"], "protecting")
        commands.assert_not_called()
        state, _, commands = self.tick(2800, late)
        self.assertEqual(state["state"], "sealed")
        self.assertEqual(commands.call_count, 2)

    def test_deadline_records_incomplete_and_does_not_claim_sealed(self):
        backup.write_json(self.state_path(), {"state": "protecting", "pending": 2,
                                               "reason": "Server tasks remain pending"})
        with patch.object(backup, "export_package") as export, patch.object(backup, "upload_package") as upload, \
                patch.object(backup, "backup_session", side_effect=RuntimeError("Cloud unavailable")), \
                patch.object(backup, "retain_partial_snapshot") as retain:
            state = backup.session_tick(self.session, now=3000)
        self.assertEqual(state["state"], "incomplete")
        self.assertEqual(state["pending"], 2)
        self.assertIn("deadline", state["reason"])
        export.assert_not_called()
        upload.assert_not_called()
        self.assertNotIn("localSnapshot", state)
        retain.assert_called_once()

    def test_deadline_protects_latest_cloud_data_and_pins_incomplete_local_copy(self):
        _, manifest = self.package(pending=2)
        backup.write_json(backup.local.ROOT / "status/last-success.json", {"snapshot": "latest-local"})
        receipt = {"snapshotId": "cutoff-cloud", "readbackVerified": True}
        result = subprocess.CompletedProcess([], 0, json.dumps({"snapshot": "latest-local"}))
        with patch.object(backup, "backup_session", return_value=(receipt, manifest)), \
                patch.object(backup.subprocess, "run", return_value=result) as pin:
            state = backup.session_tick(self.session, now=3000)
        self.assertEqual(state["state"], "incomplete")
        self.assertEqual(state["pending"], 2)
        self.assertEqual(state["cutoffCloudSnapshot"], "cutoff-cloud")
        self.assertTrue(state["cutoffCloudVerified"])
        self.assertEqual(state["provisionalLocalSnapshot"], "latest-local")
        self.assertFalse(state["provisionalSnapshotIsFinal"])
        self.assertIn("-partial-", state["provisionalSealSession"])
        self.assertEqual(pin.call_args.args[0][2], "seal")
        self.assertNotIn("localSnapshot", state)

    def test_cutoff_cloud_failure_does_not_prevent_indefinite_local_protection(self):
        backup.write_json(backup.local.ROOT / "status/last-success.json", {"snapshot": "local-only"})
        result = subprocess.CompletedProcess([], 0, json.dumps({"snapshot": "local-only"}))
        with patch.object(backup, "backup_session", side_effect=RuntimeError("Cloud offline")), \
                patch.object(backup.subprocess, "run", return_value=result):
            state = backup.session_tick(self.session, now=3000)
        self.assertEqual(state["state"], "incomplete")
        self.assertIn("Cloud offline", state["cutoffCloudError"])
        self.assertEqual(state["provisionalLocalSnapshot"], "local-only")
        self.assertFalse(state["provisionalSnapshotIsFinal"])

    def test_cutoff_local_failure_does_not_hide_verified_cloud_copy(self):
        _, manifest = self.package()
        backup.write_json(backup.local.ROOT / "status/last-success.json", {"snapshot": "missing-local"})
        with patch.object(backup, "backup_session", return_value=({"snapshotId": "cloud-ok"}, manifest)), \
                patch.object(backup.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "")):
            state = backup.session_tick(self.session, now=3000)
        self.assertEqual(state["state"], "incomplete")
        self.assertTrue(state["cutoffCloudVerified"])
        self.assertIn("retain", state["cutoffLocalError"])
        self.assertNotIn("provisionalLocalSnapshot", state)

    def test_long_cloud_verification_cannot_finalize_after_deadline(self):
        package, manifest = self.package()
        backup.write_json(self.state_path(), {"state": "protecting", "observedDigest": manifest["dataDigest"],
                                               "stableSince": 2000})
        with patch.object(backup, "export_package", return_value=(package, manifest)), \
                patch.object(backup, "upload_package"), \
                patch.object(backup.time, "monotonic", side_effect=[0, 101]), \
                patch.object(backup.subprocess, "run") as commands:
            state = backup.session_tick(self.session, now=2900)
        self.assertEqual(state["state"], "incomplete")
        self.assertIn("exceeded", state["reason"])
        commands.assert_not_called()

    def test_tick_failure_records_diagnosis_and_preserves_retry_package_and_cloud_receipt(self):
        package, manifest = self.package()
        backup.write_json(backup.session_path(self.session["session"]), self.session)
        receipt = {"snapshotId": "previous", "dataDigest": "old", "readbackVerified": True}
        backup.write_json(self.state_path("cloud"), receipt)
        with patch.object(backup.sys, "argv", ["classroom-research-backup.py", "tick", "--session", self.session["session"]]), \
                patch.object(backup.time, "time", return_value=2000), \
                patch.object(backup, "export_package", return_value=(package, manifest)), \
                patch.object(backup, "upload_package", side_effect=RuntimeError("Cloud connection unavailable")):
            with self.assertRaisesRegex(RuntimeError, "Cloud connection unavailable"):
                backup.main()
        state = json.loads(self.state_path().read_text())
        self.assertEqual(state["state"], "protecting")
        self.assertEqual(state["lastError"], "RuntimeError")
        self.assertIn("Cloud connection unavailable", state["reason"])
        self.assertEqual(json.loads(self.state_path("cloud").read_text()), receipt)
        self.assertEqual(backup.verify_package(package), manifest)

    def test_arm_is_idempotent_and_scope_and_time_changes_require_a_new_label(self):
        args = argparse.Namespace(session=self.session["session"], offering=OFFERING,
                                  start="2026-10-20T13:30:00+08:00", end="2026-10-20T17:00:00+08:00", install_timer=False)
        original = backup.arm_session(args)
        self.assertEqual(backup.arm_session(args), original)
        args.offering = OTHER
        with self.assertRaisesRegex(RuntimeError, "different scope or times"):
            backup.arm_session(args)
        self.assertEqual(backup.load_session(args.session), original)

    def test_timer_contains_only_finite_today_entries_and_installs_the_matching_service(self):
        args = argparse.Namespace(session=self.session["session"], offering=OFFERING,
                                  start="2026-10-20T13:30:00+08:00", end="2026-10-20T17:00:00+08:00", install_timer=True)
        source = backup.PROJECT / "deploy/systemd/openpbl-classroom-backup@.service"
        source.parent.mkdir(parents=True)
        shutil.copyfile(REPOSITORY / "deploy/systemd/openpbl-classroom-backup@.service", source)
        with patch.object(Path, "home", return_value=self.root / "home"), \
                patch.object(backup.subprocess, "run") as systemctl:
            backup.arm_session(args)
        directory = self.root / "home/.config/systemd/user"
        timer = (directory / ("openpbl-classroom-backup@" + args.session + ".timer")).read_text()
        entries = [line for line in timer.splitlines() if line.startswith("OnCalendar=")]
        self.assertEqual(entries[0], "OnCalendar=2026-10-20 13:15:00 Asia/Shanghai")
        self.assertEqual(entries[-1], "OnCalendar=2026-10-20 18:00:00 Asia/Shanghai")
        self.assertEqual(len(entries), 58)
        self.assertTrue(all("2026-10-20" in entry and "*" not in entry for entry in entries))
        self.assertIn("Unit=openpbl-classroom-backup@" + args.session + ".service", timer)
        self.assertEqual(systemctl.call_count, 2)
        installed_service = (directory / "openpbl-classroom-backup@.service").read_text()
        self.assertIn("WorkingDirectory=" + str(backup.PROJECT), installed_service)
        self.assertIn(str(backup.PROJECT) + "/deploy/backup/classroom-research-backup.py tick --session %i", installed_service)
        self.assertNotIn("%h/OpenPBL/openPBL", installed_service)

    def test_lock_conflict_prevents_overlapping_cloud_or_session_writes(self):
        with backup.locked():
            with self.assertRaises(BlockingIOError):
                with backup.locked():
                    self.fail("Second cloud job acquired the lock")
        with backup.locked():
            pass


if __name__ == "__main__":
    unittest.main()
