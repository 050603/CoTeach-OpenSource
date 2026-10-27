"""Local recovery safeguards, file integrity and 30-day WAL retention."""

import importlib.util
import contextlib
import gc
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "local_backup", Path(__file__).resolve().parents[2] / "deploy/backup/local-backup.py"
)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
REPOSITORY = Path(__file__).resolve().parents[2]


class LocalBackupTest(unittest.TestCase):
    def test_explicit_base_refresh_does_not_acknowledge_a_skipped_locked_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "status").mkdir()
            with (root / "status/backup.lock").open("w") as handle:
                backup.fcntl.flock(handle, backup.fcntl.LOCK_EX | backup.fcntl.LOCK_NB)
                environment = {**os.environ, "OPENPBL_LOCAL_BACKUP_DIR": str(root)}
                command = [backup.sys.executable, str(REPOSITORY / "deploy/backup/local-backup.py"), "backup"]
                ordinary = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=10)
                explicit = subprocess.run([*command, "--force-base"], env=environment, text=True, capture_output=True, timeout=10)
                self.assertEqual(ordinary.returncode, 0)
                self.assertEqual(explicit.returncode, 1)
                self.assertIn("already holds", explicit.stdout)
                self.assertFalse((root / "status/last-success.json").exists())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(backup, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        project_patch = patch.object(backup, "PROJECT", self.root)
        project_patch.start()
        self.addCleanup(project_patch.stop)
        home_patch = patch.object(Path, "home", return_value=self.root)
        home_patch.start()
        self.addCleanup(home_patch.stop)
        backup.initialize_dirs()

    def test_only_completed_snapshots_are_eligible(self):
        unfinished = self.root / "snapshots/unfinished"
        unfinished.mkdir()
        completed = self.root / "snapshots/completed"
        completed.mkdir()
        backup.write_json(completed / "manifest.json", {})
        self.assertEqual(backup.snapshots(), [completed])
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_missing_and_corrupted_database_references_fail_closed(self):
        snapshot = self.root / "snapshot"
        uploads = snapshot / "files/uploads"
        uploads.mkdir(parents=True)
        path = uploads / "submission.pdf"
        asset = {"id": "test-student-submission", "storageKey": path.name, "sha256": "incorrect"}
        with self.assertRaisesRegex(RuntimeError, "missing"):
            backup.validate_assets(snapshot, [asset])
        path.write_text("student work")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.validate_assets(snapshot, [asset])
        asset["sha256"] = backup.sha256(path)
        backup.validate_assets(snapshot, [asset])
        asset["storageKey"] = "../outside"
        with self.assertRaisesRegex(RuntimeError, "Unsafe"):
            backup.validate_assets(snapshot, [asset])

    def test_file_verification_detects_modification_even_with_same_size(self):
        snapshot = self.root / "snapshot"
        snapshot.mkdir()
        path = snapshot / "database.dump"
        path.write_text("original")
        backup.write_json(snapshot / "manifest.json", {
            "files": {path.name: {"sha256": backup.sha256(path), "size": path.stat().st_size}},
            "assets": [],
        })
        backup.verify_files(snapshot)
        path.write_text("modified")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_files(snapshot)

    def test_retention_keeps_pre_boundary_base_and_its_wal(self):
        now = time.time()
        for number, days in enumerate((40, 31, 29, 1)):
            path = self.root / "bases" / f"base-{number}"
            path.mkdir()
            backup.write_json(path / "complete.json", {
                "completedEpoch": now - days * 86400,
                "firstWal": f"00000001000000000000000{number + 1}",
            })
        for name in ("000000010000000000000001", "000000010000000000000002",
                     "000000010000000000000001.partial", "00000002.history",
                     "000000020000000000000001"):
            (self.root / "wal" / name).touch()
        backup.prune()
        self.assertEqual([path.name for path in backup.bases()], ["base-1", "base-2", "base-3"])
        self.assertFalse((self.root / "wal/000000010000000000000001").exists())
        self.assertTrue((self.root / "wal/000000010000000000000002").exists())
        self.assertTrue((self.root / "wal/000000010000000000000001.partial").exists())
        self.assertTrue((self.root / "wal/000000020000000000000001").exists())

    def test_default_base_reuses_a_verified_base_less_than_24_hours_old(self):
        base = self.root / "bases/20261019T000000000000Z"
        base.mkdir()
        complete = {"completedEpoch": time.time() - 3600, "firstWal": "000000010000000000000001",
                    "image": "fixture-image", "recoverySettings": {"max_connections": "100"}}
        backup.write_json(base / "complete.json", complete)
        with patch.object(backup, "run") as run, patch.object(backup, "sql") as sql:
            self.assertEqual(backup.take_base(), base)
        run.assert_not_called()
        sql.assert_not_called()
        self.assertEqual(json.loads((base / "complete.json").read_text()), complete)

    def base_command(self, verification_error=None):
        def execute(arguments, **_kwargs):
            command = Path(arguments[0]).name
            if command == "pg_basebackup":
                directory = Path(arguments[arguments.index("-D") + 1])
                directory.mkdir()
                backup.write_json(directory / "backup_manifest", {"WAL-Ranges": [{"Start-LSN": "0/2000000"}]})
            elif command == "pg_verifybackup":
                self.assertFalse((Path(arguments[1]).parent / "complete.json").exists())
                self.assertTrue((Path(arguments[1]) / "backup_manifest").is_file())
                if verification_error:
                    raise verification_error
            else:
                self.fail("Unexpected PostgreSQL base command: " + command)
            return subprocess.CompletedProcess(arguments, 0, "")
        return execute

    def test_force_base_verifies_a_new_base_even_when_the_previous_one_is_fresh(self):
        previous = self.root / "bases/20261019T000000000000Z"
        previous.mkdir()
        marker = {"completedEpoch": time.time(), "firstWal": "000000010000000000000001"}
        backup.write_json(previous / "complete.json", marker)
        with patch.object(backup, "client", side_effect=lambda command, *args: [command, *args]), \
                patch.object(backup, "run", side_effect=self.base_command()) as run, \
                patch.object(backup, "sql", return_value="000000010000000000000002"), \
                patch.object(backup, "image", return_value="fixture-image"), \
                patch.object(backup, "recovery_settings", return_value={"max_connections": "100"}), \
                patch("builtins.print"):
            current = backup.take_base(force=True)
        self.assertNotEqual(current, previous)
        self.assertEqual([Path(call.args[0][0]).name for call in run.call_args_list], ["pg_basebackup", "pg_verifybackup"])
        self.assertEqual(json.loads((previous / "complete.json").read_text()), marker)
        self.assertEqual(json.loads((current / "complete.json").read_text())["image"], "fixture-image")

    def test_force_base_verification_failure_keeps_the_last_acknowledged_recovery_point(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup, "client", side_effect=lambda command, *args: [command, *args]), \
                patch.object(backup, "run", side_effect=self.base_command(RuntimeError("base verification failed"))), \
                patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)), \
                patch.object(backup, "dump_consistent") as dump:
            with self.assertRaisesRegex(RuntimeError, "base verification failed"):
                backup.backup(force_base=True)
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.bases(), [])
        self.assertEqual(backup.snapshots(), [])
        dump.assert_not_called()

    def recovery_snapshot(self, name, base_name="base-0", days=0, first_wal="000000010000000000000002"):
        completed = time.time() - days * 86400
        base = self.root / "bases" / base_name
        if not base.exists():
            (base / "data").mkdir(parents=True)
            backup.write_json(base / "complete.json", {"completedEpoch": completed - 60,
                                                       "firstWal": first_wal, "image": "isolated-fixture-image"})
        target = self.root / "snapshots" / name
        (target / "files").mkdir(parents=True)
        database = target / "database.dump"
        database.write_bytes(b"isolated database fixture")
        backup.write_json(target / "manifest.json", {
            "startedEpoch": completed - 10, "completedEpoch": completed, "base": base_name,
            "restorePoint": "openpbl_local_" + name, "lsn": "0/1000002", "lastWal": first_wal, "tables": {}, "assets": [],
            "files": {database.name: {"sha256": backup.sha256(database), "size": database.stat().st_size}},
        })
        return target

    def test_classroom_seal_is_indefinite_idempotent_and_does_not_follow_newer_snapshots(self):
        original = self.recovery_snapshot("snapshot-1")
        with patch("builtins.print"):
            record = backup.seal("intro-ai-2026-10-20")
            self.recovery_snapshot("snapshot-2", "base-1")
            self.assertEqual(backup.seal("intro-ai-2026-10-20"), record)
            self.assertEqual(backup.seal("intro-ai-2026-10-20", original.name), record)
            with self.assertRaisesRegex(RuntimeError, "cannot be rebound"):
                backup.seal("intro-ai-2026-10-20", "snapshot-2")
        self.assertEqual(record["retention"], "indefinite")
        self.assertEqual(record["snapshot"], original.name)
        self.assertEqual(backup.select_snapshot(session=record["session"]), original)
        self.assertEqual(backup.select_snapshot("snapshot-2").name, "snapshot-2")
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            backup.select_snapshot("snapshot-2", record["session"])
        self.assertEqual(len(list((self.root / "seals").glob("*.json"))), 1)

    def test_classroom_seal_rejects_invalid_incomplete_corrupt_or_external_snapshots(self):
        target = self.recovery_snapshot("valid")
        (self.root / "snapshots/unfinished").mkdir()
        linked = self.root / "snapshots/linked"
        linked.symlink_to(target, target_is_directory=True)
        for name in ("../valid", "/valid", "missing", "unfinished", "linked"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                backup.seal("session", name)
        with self.assertRaisesRegex(RuntimeError, "Invalid session"):
            backup.seal("../session", target.name)
        (target / "database.dump").write_bytes(b"changed fixture contents")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.seal("session", target.name)
        self.assertEqual(list((self.root / "seals").glob("*.json")), [])
        (self.root / "bases/base-0/complete.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "completed PostgreSQL base"):
            backup.seal("session", target.name)

    def test_seal_rejects_uninventoried_database_or_incomplete_recovery_metadata(self):
        target = self.recovery_snapshot("valid")
        manifest_path = target / "manifest.json"
        original = json.loads(manifest_path.read_text())
        for changes in ({"files": {}}, {"completedEpoch": None}, {"restorePoint": "unsafe'point"}, {"tables": []}):
            with self.subTest(changes=changes):
                backup.write_json(manifest_path, {**original, **changes})
                with self.assertRaises(RuntimeError):
                    backup.seal("session", target.name)
        self.assertEqual(list((self.root / "seals").glob("*.json")), [])

    def test_seal_selection_and_creation_share_the_backup_lock(self):
        self.recovery_snapshot("completed")
        with backup.lock():
            with self.assertRaises(BlockingIOError):
                backup.seal("session")
        self.assertEqual(list((self.root / "seals").glob("*.json")), [])
        with patch("builtins.print"):
            backup.seal("session")
        self.assertEqual(backup.select_snapshot(session="session").name, "completed")

    def test_expired_classroom_seal_preserves_snapshot_base_and_wal_until_explicit_removal(self):
        sealed = self.recovery_snapshot("snapshot-0", "base-0", days=50)
        expired = self.recovery_snapshot("snapshot-1", "base-1", days=40,
                                         first_wal="000000010000000000000003")
        recent = self.recovery_snapshot("snapshot-2", "base-2", days=1,
                                        first_wal="000000010000000000000004")
        for number in range(1, 5):
            (self.root / "wal" / f"00000001000000000000000{number}").touch()
        with patch("builtins.print"):
            backup.seal("classroom", sealed.name)
        backup.prune()
        self.assertTrue(sealed.exists())
        self.assertFalse(expired.exists())
        self.assertTrue(recent.exists())
        self.assertEqual([path.name for path in backup.bases()], ["base-0", "base-1", "base-2"])
        self.assertFalse((self.root / "wal/000000010000000000000001").exists())
        self.assertTrue((self.root / "wal/000000010000000000000002").exists())
        # There is deliberately no automatic expiry or command to remove seals.
        (self.root / "seals/classroom.json").unlink()
        backup.prune()
        self.assertFalse(sealed.exists())
        self.assertFalse((self.root / "bases/base-0").exists())
        self.assertFalse((self.root / "wal/000000010000000000000002").exists())

    def test_retention_preserves_each_timeline_needed_by_sealed_bases(self):
        self.recovery_snapshot("snapshot-0", "base-0", days=50)
        self.recovery_snapshot("snapshot-1", "base-1", days=1,
                               first_wal="000000020000000000000004")
        for name in ("000000010000000000000001", "000000010000000000000002",
                     "000000020000000000000003", "000000020000000000000004",
                     "000000020000000000000003.partial", "00000002.history", "000000030000000000000001"):
            (self.root / "wal" / name).touch()
        with patch("builtins.print"):
            backup.seal("classroom", "snapshot-0")
        backup.prune()
        self.assertFalse((self.root / "wal/000000010000000000000001").exists())
        self.assertFalse((self.root / "wal/000000020000000000000003").exists())
        for name in ("000000010000000000000002", "000000020000000000000004",
                     "000000020000000000000003.partial", "00000002.history", "000000030000000000000001"):
            self.assertTrue((self.root / "wal" / name).exists())

    def test_pin_keeps_only_its_bounded_wal_interval_outside_the_normal_window(self):
        pinned = self.recovery_snapshot("snapshot-0", "base-0", days=50)
        manifest = json.loads((pinned / "manifest.json").read_text())
        manifest["lastWal"] = "000000010000000000000004"
        backup.write_json(pinned / "manifest.json", manifest)
        self.recovery_snapshot("snapshot-1", "base-1", days=31,
                               first_wal="000000010000000000000007")
        self.recovery_snapshot("snapshot-2", "base-2", days=1,
                               first_wal="000000010000000000000009")
        for number in range(1, 11):
            (self.root / "wal" / f"0000000100000000000000{number:02X}").touch()
        with patch("builtins.print"):
            record = backup.seal("classroom", pinned.name)
        backup.prune()
        self.assertEqual(record["lastWal"], manifest["lastWal"])
        expected = {2, 3, 4, 7, 8, 9, 10}
        self.assertEqual({int(path.name[-2:], 16) for path in (self.root / "wal").iterdir()}, expected)
        self.assertTrue((self.root / "bases/base-0").exists())

    def test_legacy_pin_is_conservative_until_explicit_reseal_records_its_endpoint(self):
        pinned = self.recovery_snapshot("snapshot-0", "base-0", days=50)
        self.recovery_snapshot("snapshot-1", "base-1", days=31,
                               first_wal="000000010000000000000007")
        self.recovery_snapshot("snapshot-2", "base-2", days=1,
                               first_wal="000000010000000000000009")
        with patch("builtins.print"):
            record = backup.seal("classroom", pinned.name)
        record.pop("lastWal")
        record.pop("walRetention")
        seal_path = self.root / "seals/classroom.json"
        backup.write_json(seal_path, record)
        gap = self.root / "wal/000000010000000000000005"
        gap.touch()
        self.assertIn("legacy-unbounded", backup.read_seal(seal_path)["walRetention"])
        backup.prune()
        self.assertTrue(gap.exists())
        with patch("builtins.print"):
            upgraded = backup.seal("classroom")
        self.assertEqual(upgraded["lastWal"], "000000010000000000000002")
        self.assertEqual(upgraded["walRetention"], "bounded")
        backup.prune()
        self.assertFalse(gap.exists())

    def test_historical_snapshot_endpoint_uses_read_only_lsn_query(self):
        pinned = self.recovery_snapshot("snapshot-0")
        manifest = json.loads((pinned / "manifest.json").read_text())
        manifest.pop("lastWal")
        backup.write_json(pinned / "manifest.json", manifest)
        with patch("builtins.print"), patch.object(backup, "sql", return_value="000000010000000000000003") as sql:
            record = backup.seal("classroom", pinned.name)
        sql.assert_called_once_with("SELECT pg_walfile_name('0/1000002'::pg_lsn)")
        self.assertEqual(record["lastWal"], "000000010000000000000003")

    def test_corrupt_or_missing_seal_dependency_stops_prune_before_any_deletion(self):
        pinned = self.recovery_snapshot("snapshot-0", "base-0", days=50)
        expired = self.recovery_snapshot("snapshot-1", "base-1", days=40)
        with patch("builtins.print"):
            backup.seal("classroom", pinned.name)
        manifest = pinned / "manifest.json"
        original = manifest.read_bytes()
        manifest.write_bytes(original + b"\n")
        with self.assertRaisesRegex(RuntimeError, "Sealed recovery metadata changed"):
            backup.prune()
        self.assertTrue(expired.exists())
        manifest.write_bytes(original)
        shutil.rmtree(self.root / "bases/base-0")
        with self.assertRaisesRegex(RuntimeError, "completed PostgreSQL base"):
            backup.prune()
        self.assertTrue(expired.exists())

    def test_drill_can_target_a_sealed_snapshot_instead_of_the_latest(self):
        pinned = self.recovery_snapshot("snapshot-0")
        with patch("builtins.print"):
            backup.seal("classroom", pinned.name)
        self.recovery_snapshot("snapshot-1", "base-1")
        for arguments in ({"session": "classroom"}, {"snapshot_name": pinned.name}):
            with self.subTest(arguments=arguments), \
                    patch.object(backup, "verify_files", side_effect=RuntimeError("stop before restore")) as verify:
                with self.assertRaisesRegex(RuntimeError, "stop before restore"):
                    backup.drill(**arguments)
                verify.assert_called_once_with(pinned)

    def test_cli_passes_seal_and_drill_selectors_and_rejects_unrelated_flags(self):
        with patch.object(backup.sys, "argv", ["local-backup.py", "pin", "--session", "classroom", "--snapshot", "completed"]), \
                patch.object(backup, "seal") as seal:
            self.assertEqual(backup.main(), 0)
            seal.assert_called_once_with("classroom", "completed")
        with patch.object(backup.sys, "argv", ["local-backup.py", "drill", "--session", "classroom"]), \
                patch.object(backup, "drill") as drill:
            drill.return_value = None
            self.assertEqual(backup.main(), 0)
            drill.assert_called_once_with(snapshot_name=None, session="classroom")
        with patch.object(backup.sys, "argv", ["local-backup.py", "backup", "--session", "classroom"]), \
                patch.object(backup.sys, "stderr"):
            with self.assertRaises(SystemExit) as raised:
                backup.main()
            self.assertEqual(raised.exception.code, 2)

    def test_cli_force_base_is_explicit_and_only_valid_for_backup(self):
        for arguments, forced in ((["backup"], False), (["backup", "--force-base"], True)):
            with self.subTest(arguments=arguments), \
                    patch.object(backup.sys, "argv", ["local-backup.py", *arguments]), \
                    patch.object(backup, "backup", return_value=None) as perform:
                self.assertEqual(backup.main(), 0)
                perform.assert_called_once_with(force_base=forced)
        with patch.object(backup.sys, "argv", ["local-backup.py", "drill", "--force-base"]), \
                patch.object(backup.sys, "stderr"):
            with self.assertRaises(SystemExit) as raised:
                backup.main()
            self.assertEqual(raised.exception.code, 2)

    def test_wal_flush_timeout_does_not_acknowledge_a_recovery_point(self):
        with patch.object(backup, "sql", return_value="f"):
            with self.assertRaisesRegex(RuntimeError, "not durably flushed"):
                backup.ensure_wal_received("0/123", timeout=0)

    def test_low_disk_space_refuses_backup_without_acknowledging_a_recovery_point(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024**3 - 1)) as usage, \
                patch.object(backup, "take_base") as take_base, \
                patch.object(backup, "dump_consistent") as dump:
            with self.assertRaisesRegex(RuntimeError, "Less than 10 GiB free"):
                backup.backup()
        usage.assert_called_once_with(self.root)
        take_base.assert_not_called()
        dump.assert_not_called()
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.bases(), [])
        self.assertEqual(backup.snapshots(), [])

    def test_disk_write_failure_preserves_last_acknowledged_recovery_point(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)), \
                patch.object(backup, "take_base", return_value=self.root / "bases/previous"), \
                patch.object(backup, "dump_consistent", return_value=({}, [])), \
                patch.object(backup, "snapshot_source", return_value={"gitHead": "test"}), \
                patch.object(backup, "snapshot_files", side_effect=OSError("No space left on device")):
            with self.assertRaises(OSError):
                backup.backup()
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.snapshots(), [])

    def test_queued_audit_survives_source_drain_after_outbox_copy(self):
        source = self.root / ".openpbl-data/ai-audit-outbox"
        source.mkdir(parents=True)
        event = source / "pending.json"
        event.write_text('{"requestId":"stable-request","content":"complete conversation"}')
        quarantine = source / "quarantine"
        quarantine.mkdir()
        malformed = quarantine / "malformed.json"
        malformed.write_bytes(b"{invalid original bytes")
        target = self.root / "snapshots/next"
        backup.snapshot_audit_outbox(target)
        event.unlink()
        malformed.unlink()
        self.assertEqual(json.loads((target / "files/ai-audit-outbox/pending.json").read_text())["requestId"], "stable-request")
        self.assertEqual((target / "files/ai-audit-outbox/quarantine/malformed.json").read_bytes(), b"{invalid original bytes")

    def evidence_snapshot(self, name, previous=None):
        for category in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / category).mkdir(parents=True, exist_ok=True)
        target = self.root / "snapshots" / name
        target.mkdir()
        files = backup.snapshot_files(target, previous)
        backup.write_json(target / "manifest.json", {"files": files, "assets": []})
        backup.verify_files(target)
        return target, files

    def test_installed_user_units_dropins_timer_and_allowlisted_config_preserve_bytes_and_modes(self):
        units = self.root / ".config/systemd/user"
        expected = {
            "installed-user-units/openpbl.service": (b"[Service]\nExecStart=/fixture/application\n", 0o644),
            "installed-user-units/openpbl-local-backup.timer": (b"[Timer]\nOnUnitActiveSec=5min\n", 0o640),
            "installed-user-units/openpbl.service.d/40-runtime-build.conf": (b"[Service]\nEnvironment=BUILD_DIR=fixture\n", 0o640),
            "installed-user-units/openpbl.service.d/50-course-read.conf": (b"[Service]\nEnvironmentFile=%h/.config/openpbl/course-read.env\n", 0o600),
            "installed-user-config/course-read.env": (b"COURSE_READ_DATABASE_URL=isolated-fixture\n", 0o600),
            "installed-user-config/site.env": (b"OPENPBL_PUBLIC_BASE_URL=https://teaching.example.invalid\n", 0o600),
        }
        for relative, (contents, mode) in expected.items():
            source = (units / relative.removeprefix("installed-user-units/")
                      if relative.startswith("installed-user-units/")
                      else self.root / ".config/openpbl" / relative.removeprefix("installed-user-config/"))
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(contents)
            source.chmod(mode)
        excluded = ("systemd/user/other.service", "systemd/user/other.timer",
                    "systemd/user/other.service.d/50-secret.conf", "systemd/user/openpbl.service.d/unrelated.env",
                    "openpbl/other.env", "other-app/course-read.env")
        for relative in excluded:
            source = self.root / ".config" / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b"excluded private fixture")
        snapshot, files = self.evidence_snapshot("installed-runtime-config")
        recorded = {relative.removeprefix("configuration/") for relative in files if relative.startswith("configuration/installed-")}
        self.assertEqual(recorded, set(expected))
        for relative, (contents, mode) in expected.items():
            restored = snapshot / "configuration" / relative
            self.assertEqual(restored.read_bytes(), contents)
            self.assertEqual(restored.stat().st_mode & 0o777, mode)
            self.assertEqual(files["configuration/" + relative]["mode"], mode)

    def test_missing_optional_user_config_and_units_keep_old_deployments_verifiable(self):
        snapshot, files = self.evidence_snapshot("without-user-runtime-config")
        self.assertFalse(any(relative.startswith("configuration/installed-") for relative in files))
        self.assertFalse((snapshot / "configuration/installed-user-config").exists())
        backup.verify_files(snapshot)

    def test_optional_evidence_absent_keeps_older_deployment_backup_valid(self):
        _, files = self.evidence_snapshot("without-evidence")
        self.assertFalse(any(key.startswith("files/capacity-evidence/") for key in files))
        shutil.rmtree(self.root / ".openpbl-data/uploads")
        target = self.root / "snapshots/missing-business"; target.mkdir()
        with self.assertRaisesRegex(RuntimeError, "Required data directory"):
            backup.snapshot_files(target, None)

    def test_evidence_original_bytes_incremental_hashes_and_restore_corruption(self):
        directory = self.root / ".openpbl-data/capacity-evidence/capacity-00000000-0000-4000-8000-000000000001"
        directory.mkdir(parents=True)
        original = b'{"outcome":"failed","expected":{"original":"unmodified"}}\n'
        (directory / "report.json").write_bytes(original)
        first, files = self.evidence_snapshot("evidence-first")
        relative = "files/" + str(directory.relative_to(self.root / ".openpbl-data")) + "/report.json"
        self.assertEqual((first / relative).read_bytes(), original)
        self.assertEqual(files[relative]["sha256"], backup.sha256(directory / "report.json"))
        second, _ = self.evidence_snapshot("evidence-second", first)
        self.assertEqual((first / relative).stat().st_ino, (second / relative).stat().st_ino)
        (directory / "report.json").write_bytes(b'{"outcome":"partial"}\n')
        third, _ = self.evidence_snapshot("evidence-third", second)
        self.assertEqual((first / relative).read_bytes(), original)
        self.assertNotEqual((first / relative).stat().st_ino, (third / relative).stat().st_ino)
        (third / relative).write_bytes(b'corrupted')
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_files(third)

    def test_optional_evidence_rejects_symlink_instead_of_reading_outside_root(self):
        directory = self.root / ".openpbl-data/capacity-evidence"
        directory.mkdir(parents=True)
        outside = self.root / "outside-secret"; outside.write_bytes(b'private')
        (directory / "linked.json").symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            self.evidence_snapshot("evidence-symlink")

    def test_nonempty_live_sqlite_wal_snapshot_is_complete_and_readable(self):
        for name in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / name).mkdir(parents=True)
        source = self.root / ".openpbl-data/whiteboards/synthetic.sqlite"
        target = self.root / "snapshots/sqlite-check"
        target.mkdir()
        with contextlib.closing(sqlite3.connect(source)) as live:
            live.execute("PRAGMA journal_mode=WAL")
            live.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL)")
            expected = [("first", '{"shape":"rect"}'), ("second", '{"text":"complete evidence"}')]
            live.executemany("INSERT INTO documents VALUES (?, ?)", expected)
            live.commit()
            self.assertTrue(Path(str(source) + "-wal").exists())
            checksums = backup.snapshot_files(target, None)
        # Explicit close must stabilize the manifest before a later GC pass.
        gc.collect()
        self.assertTrue(all((target / relative).is_file() for relative in checksums))
        self.assertFalse(any(relative.endswith(("-wal", "-shm")) for relative in checksums))
        restored = target / "files/whiteboards/synthetic.sqlite"
        with contextlib.closing(sqlite3.connect(f"file:{restored}?mode=ro&immutable=1", uri=True)) as recovered:
            self.assertEqual(recovered.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(recovered.execute("SELECT id, content FROM documents ORDER BY id").fetchall(), expected)
        self.assertEqual(checksums["files/whiteboards/synthetic.sqlite"]["sha256"], backup.sha256(restored))
        self.assertFalse(Path(str(restored) + "-wal").exists())

    @unittest.skipIf(os.geteuid() == 0, "Root bypasses filesystem permission failures")
    def test_actual_isolated_write_denial_preserves_previous_status(self):
        status = self.root / "status/last-success.json"
        backup.write_json(status, {"snapshot": "verified"})
        status.parent.chmod(0o500)
        try:
            with self.assertRaises(PermissionError):
                backup.write_json(status, {"snapshot": "incomplete"})
            self.assertEqual(json.loads(status.read_text()), {"snapshot": "verified"})
        finally:
            status.parent.chmod(0o700)

    def test_health_rejects_old_snapshot_or_lost_receiver(self):
        backup.write_json(self.root / "status/last-success.json", {"startedEpoch": time.time() - 901})
        with patch.object(backup, "sql", return_value=json.dumps([{"active": True, "status": "reserved"}])):
            self.assertEqual(backup.status(), 1)
        backup.write_json(self.root / "status/last-success.json", {"startedEpoch": time.time()})
        with patch.object(backup, "sql", return_value=json.dumps([{"active": False, "status": "lost"}])):
            self.assertEqual(backup.status(), 1)
        with patch.object(backup, "sql", return_value=json.dumps([{"active": True, "status": "reserved"}])):
            self.assertEqual(backup.status(), 0)

    def test_local_monitor_reports_stale_state_and_recovery_only_on_changes(self):
        def unit_state(_unit, property_name):
            return "success" if property_name == "Result" else "active"

        with patch.object(backup, "unit_property", side_effect=unit_state), patch("builtins.print") as emit:
            with patch.object(backup, "health_snapshot", return_value={"healthy": False}):
                self.assertEqual(backup.monitor(), 1)
                self.assertEqual(backup.monitor(), 1)
                self.assertEqual(emit.call_count, 1)
                self.assertEqual(json.loads((self.root / "status/health.json").read_text())["state"], "alert")
            with patch.object(backup, "health_snapshot", return_value={"healthy": True}):
                self.assertEqual(backup.monitor(), 0)
                self.assertEqual(emit.call_count, 2)
                self.assertEqual(json.loads((self.root / "status/health.json").read_text())["state"], "ok")

    def test_local_monitor_fails_when_services_fail_even_if_snapshot_is_fresh(self):
        def unit_state(_unit, property_name):
            return "exit-code" if property_name == "Result" else "inactive"

        with patch.object(backup, "unit_property", side_effect=unit_state), \
                patch.object(backup, "health_snapshot", return_value={"healthy": True}), patch("builtins.print"):
            self.assertEqual(backup.monitor(), 1)
        state = json.loads((self.root / "status/health.json").read_text())
        self.assertEqual(len(state["reasons"]), 3)

    def prepare_source_fixture(self):
        files = set(backup.SOURCE_REQUIRED_FILES) | {"patches/docx.patch", "prisma/migrations/20260101_initial/migration.sql",
                                                   "src/deleted.ts", "public/font.woff2", ".gitignore"}
        for relative in files:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original source\n")
        (self.root / ".gitignore").write_text("node_modules/\n.env.local\ndeploy/secrets/\n")
        (self.root / "package.json").write_text(json.dumps({"scripts": {"build": "node scripts/build-document-converter-worker.mjs"},
            "pnpm": {"patchedDependencies": {"@platejs/docx-io@53.3.2": "patches/docx.patch"}}}))
        subprocess.run(["git", "init", "--quiet", self.root], check=True, capture_output=True)
        subprocess.run(["git", "-C", self.root, "add", "--", *sorted(files)], check=True, capture_output=True)
        subprocess.run(["git", "-C", self.root, "-c", "user.name=Backup Test", "-c", "user.email=backup-test@invalid",
                        "commit", "--quiet", "-m", "isolated source fixture"], check=True, capture_output=True)

    def source_target(self, name="source-check"):
        target = self.root / "snapshots" / name
        target.mkdir()
        return target

    def prepare_production_source_fixture(self):
        self.prepare_source_fixture()
        package_path = self.root / "package.json"
        package = json.loads(package_path.read_text())
        current_package = json.loads((REPOSITORY / "package.json").read_text())
        package["scripts"]["build"] = current_package["scripts"]["build"]
        package_path.write_text(json.dumps(package))
        for relative in backup.SOURCE_PRODUCTION_TASK_FILES:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / relative, destination)

    def test_production_task_source_snapshot_and_restore_keep_actual_pipeline_inputs(self):
        self.prepare_production_source_fixture()
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        restored = self.root / "restored-production-source"
        shutil.copytree(target, restored)
        shutil.rmtree(self.root / "scripts")
        report = backup.verify_source(restored, metadata)
        self.assertTrue(report["verified"])
        self.assertTrue(report["workerBuildInputsVerified"])
        for relative in ("scripts/run-production-task.mjs", "scripts/lib/production-assets.mjs",
                         "scripts/lib/production-runtime-release.mjs", "src/lib/browser/pdf-runtime-version.json"):
            self.assertEqual((restored / "source" / relative).read_bytes(), (REPOSITORY / relative).read_bytes())

    def prepare_distribution_source_fixture(self):
        self.prepare_production_source_fixture()
        files = {"Dockerfile", ".dockerignore", "LICENSE", "NOTICE", "CITATION.cff", "THIRD_PARTY_NOTICES.md", "README.md", "CONTRIBUTING.md", "SECURITY.md",
                 ".gitleaks.toml", "docs/open-source.md", "scripts/check-public-content.py", "tests/test_public_content.py"}
        for directory in ("licenses", ".github"):
            files.update(path.relative_to(REPOSITORY).as_posix()
                         for path in (REPOSITORY / directory).rglob("*") if path.is_file())
        files.update("packages/" + name + "/LICENSE" for name in (
            "@openmaic/dsl", "@openmaic/generation", "@openmaic/importer", "@openmaic/renderer",
            "mathml2omml", "omml2mathml", "pptxgenjs"))
        for relative in files:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / relative, destination)
        return files

    def test_source_restore_preserves_actual_distribution_licenses_and_public_content_checks(self):
        expected = self.prepare_distribution_source_fixture()
        # The new authored directories do not permit runtime or audit outputs.
        forbidden = ("docs/reports/private.md", ".github/secrets/token.txt", "licenses/.env.local")
        for relative in forbidden:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("private fixture")
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        restored = self.root / "restored-distribution-source"
        shutil.copytree(target, restored)
        for directory in ("licenses", ".github", "scripts"):
            shutil.rmtree(self.root / directory)
        (self.root / "THIRD_PARTY_NOTICES.md").unlink()
        self.assertTrue(backup.verify_source(restored, metadata)["verified"])
        for relative in expected:
            self.assertEqual((restored / "source" / relative).read_bytes(), (REPOSITORY / relative).read_bytes())
        self.assertTrue(all(not (restored / "source" / relative).exists() for relative in forbidden))
        result = subprocess.run([backup.sys.executable, str(restored / "source/tests/test_public_content.py")],
                                cwd=restored / "source", text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_docker_distribution_snapshot_rejects_missing_copied_license_inputs(self):
        self.prepare_distribution_source_fixture()
        required = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses"] + ["packages/" + name + "/LICENSE" for name in (
            "@openmaic/dsl", "@openmaic/generation", "@openmaic/importer", "@openmaic/renderer",
            "mathml2omml", "omml2mathml", "pptxgenjs")]
        for index, relative in enumerate(required):
            with self.subTest(relative=relative):
                path = self.root / relative
                removed = self.root / "removed-license-input"
                path.rename(removed)
                try:
                    with self.assertRaisesRegex(RuntimeError, "missing Docker license inputs") as failure:
                        backup.snapshot_source(self.source_target(f"missing-license-{index}"))
                    self.assertIn(relative, str(failure.exception))
                finally:
                    removed.rename(path)

    def test_legacy_dockerfile_without_distribution_copies_does_not_require_new_notices(self):
        self.prepare_source_fixture()
        (self.root / "Dockerfile").write_text("FROM node:22-alpine\nCOPY package.json ./\nCOPY . .\n")
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        self.assertTrue(backup.verify_source(target, metadata)["verified"])
        self.assertFalse((target / "source/licenses").exists())
        self.assertFalse((target / "source/THIRD_PARTY_NOTICES.md").exists())

    def test_production_task_snapshot_rejects_missing_new_build_dependencies(self):
        self.prepare_production_source_fixture()
        required = ("scripts/run-production-task.mjs", "scripts/lib/production-assets.mjs",
                    "scripts/lib/production-runtime-release.mjs", "src/lib/browser/pdf-runtime-version.json",
                    "scripts/build-course-read-worker.mjs", "scripts/check-course-read-worker.mjs",
                    "scripts/lib/course-read-worker-artifact.mjs", "src/lib/courses/course-read-worker-entry.ts")
        for index, relative in enumerate(required):
            with self.subTest(relative=relative):
                path = self.root / relative
                contents = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(RuntimeError, "production task build inputs"):
                        backup.snapshot_source(self.source_target(f"missing-production-{index}"))
                finally:
                    path.write_bytes(contents)

    def test_production_task_driver_must_still_generate_docx_worker(self):
        self.prepare_production_source_fixture()
        driver = self.root / "scripts/run-production-task.mjs"
        driver.write_text(driver.read_text().replace("scripts/build-document-converter-worker.mjs", "scripts/omitted-worker.mjs"))
        with self.assertRaisesRegex(RuntimeError, "does not generate the DOCX worker"):
            backup.snapshot_source(self.source_target())

    def test_production_build_cannot_select_only_typecheck_task(self):
        self.prepare_production_source_fixture()
        package_path = self.root / "package.json"
        package = json.loads(package_path.read_text())
        package["scripts"]["build"] = "node scripts/run-production-task.mjs typecheck"
        package_path.write_text(json.dumps(package))
        with self.assertRaisesRegex(RuntimeError, "does not select the production build task"):
            backup.snapshot_source(self.source_target())

    def test_legacy_direct_build_snapshot_remains_restorable_without_new_pipeline_files(self):
        self.prepare_source_fixture()
        self.assertTrue(all(not (self.root / relative).exists() for relative in backup.SOURCE_PRODUCTION_TASK_FILES))
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        self.assertTrue(backup.verify_source(target, metadata)["verified"])

    def test_source_snapshot_preserves_working_tree_and_excludes_credentials_and_generated_data(self):
        self.prepare_source_fixture()
        engine = "src/lib/project-practice/document-conversion-engine.ts"
        (self.root / engine).write_text("uncommitted engine change\n")
        (self.root / "src/new-worker-helper.ts").write_text("untracked build input\n")
        artifact_route = self.root / "src/app/api/showcase/artifacts/route.ts"
        artifact_route.parent.mkdir(parents=True)
        artifact_route.write_text("authored artifact route\n")
        (self.root / "src/deleted.ts").unlink()
        forbidden = ("src/credentials/credential.json", "public/node_modules/package.js", "prisma/production.db",
                     "scripts/.npmrc", "deploy/secrets/token.txt", ".git-credentials", "test-results/huge.bin",
                     "workers/docx-converter.cjs", ".openpbl-data/database.dump", "packages/component/dist/generated.js",
                     "tests/load/reports/large.json")
        for relative in forbidden:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private or generated fixture")
            # Even force-tracked forbidden paths may not leak into source.
            subprocess.run(["git", "-C", self.root, "add", "-f", "--", relative], check=True, capture_output=True)
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        report = backup.verify_source(target, metadata)
        self.assertTrue(metadata["gitDirty"])
        self.assertTrue(report["workerBuildInputsVerified"])
        self.assertFalse(report["applicationRebuilt"])
        self.assertEqual((target / "source" / engine).read_text(), "uncommitted engine change\n")
        self.assertTrue((target / "source/src/new-worker-helper.ts").is_file())
        self.assertTrue((target / "source/src/app/api/showcase/artifacts/route.ts").is_file())
        self.assertFalse((target / "source/src/deleted.ts").exists())
        self.assertTrue((target / "source/public/font.woff2").is_file())
        self.assertTrue(all(not (target / "source" / path).exists() for path in forbidden))
        self.assertFalse((target / "source/.git").exists())

    def test_source_snapshot_fails_if_worker_or_pinned_patch_or_migration_is_missing(self):
        self.prepare_source_fixture()
        for index, relative in enumerate(("scripts/build-document-converter-worker.mjs", "patches/docx.patch",
                                          "prisma/migrations/20260101_initial/migration.sql")):
            path = self.root / relative
            content = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(RuntimeError, "build inputs|patch|migrations"):
                backup.snapshot_source(self.source_target(f"missing-{index}"))
            path.write_bytes(content)

    def test_source_snapshot_rejects_symlink_instead_of_copying_external_bytes(self):
        self.prepare_source_fixture()
        outside = self.root / "outside-secret"
        outside.write_text("private fixture")
        (self.root / "src/link.ts").symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            backup.snapshot_source(self.source_target())

    def test_isolated_source_restore_is_independent_and_detects_corruption_and_mode_changes(self):
        self.prepare_source_fixture()
        script = "scripts/build-document-converter-worker.mjs"
        (self.root / script).chmod(0o750)
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        recovered = self.root / "isolated-recovered-source"
        shutil.copytree(target, recovered)
        (self.root / script).write_text("later production edit\n")
        self.assertTrue(backup.verify_source(recovered, metadata)["verified"])
        path = recovered / "source" / script
        path.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "mode mismatch"):
            backup.verify_source(recovered, metadata)
        path.chmod(0o750)
        path.write_text("modified source\n")
        with self.assertRaisesRegex(RuntimeError, "checksum or mode mismatch"):
            backup.verify_source(recovered, metadata)

    def test_source_manifest_and_inventory_cannot_silently_drop_or_add_inputs(self):
        self.prepare_source_fixture()
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        extra = target / "source/src/unlisted.ts"
        extra.write_text("unlisted")
        with self.assertRaisesRegex(RuntimeError, "inventory mismatch"):
            backup.verify_source(target, metadata)
        extra.unlink()
        manifest = target / "source-manifest.json"
        manifest.write_text(manifest.read_text() + " ")
        with self.assertRaisesRegex(RuntimeError, "manifest checksum mismatch"):
            backup.verify_source(target, metadata)
        self.assertFalse(backup.source_path_allowed("src/../private.ts"))
        self.assertFalse(backup.source_path_allowed("/src/private.ts"))
        self.assertFalse(backup.source_path_allowed("src\\private.ts"))

    def test_source_changes_while_copying_are_not_acknowledged(self):
        self.prepare_source_fixture()
        original_copy = shutil.copy2
        def changing_copy(source, destination, **kwargs):
            result = original_copy(source, destination, **kwargs)
            if Path(source).name == "document-conversion-engine.ts":
                Path(source).write_text("changed during snapshot")
            return result
        with patch.object(backup.shutil, "copy2", side_effect=changing_copy):
            with self.assertRaisesRegex(RuntimeError, "changed during snapshot"):
                backup.snapshot_source(self.source_target())

    def test_source_failure_preserves_last_acknowledged_checkpoint(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)), \
                patch.object(backup, "take_base", return_value=self.root / "bases/previous"), \
                patch.object(backup, "dump_consistent", return_value=({}, [])), \
                patch.object(backup, "snapshot_source", side_effect=RuntimeError("source incomplete")):
            with self.assertRaisesRegex(RuntimeError, "source incomplete"):
                backup.backup()
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.snapshots(), [])

    def test_incremental_dedup_preserves_changed_source_and_configuration_modes(self):
        for name in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / name).mkdir(parents=True)
        config = self.root / ".env.local"
        config.write_text("nonsecret fixture")
        config.chmod(0o600)
        first = self.source_target("first")
        first_source = first / "source/src/executable.ts"
        first_source.parent.mkdir(parents=True)
        first_source.write_text("same source bytes")
        first_source.chmod(0o600)
        first_files = backup.snapshot_files(first, None)
        backup.write_json(first / "manifest.json", {"files": first_files, "assets": []})
        config.chmod(0o640)
        second = self.source_target("second")
        second_source = second / "source/src/executable.ts"
        second_source.parent.mkdir(parents=True)
        second_source.write_text("same source bytes")
        second_source.chmod(0o700)
        second_files = backup.snapshot_files(second, first)
        backup.write_json(second / "manifest.json", {"files": second_files, "assets": []})
        backup.verify_files(second)
        self.assertEqual(second_source.stat().st_mode & 0o777, 0o700)
        self.assertNotEqual(second_source.stat().st_ino, first_source.stat().st_ino)
        self.assertEqual((second / "configuration/.env.local").stat().st_mode & 0o777, 0o640)
        third = self.source_target("third")
        third_source = third / "source/src/executable.ts"
        third_source.parent.mkdir(parents=True)
        shutil.copy2(second_source, third_source)
        backup.snapshot_files(third, second)
        self.assertEqual(third_source.stat().st_ino, second_source.stat().st_ino)


if __name__ == "__main__":
    unittest.main()
