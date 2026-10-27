"""Public source boundaries, exercised against real isolated Git indexes."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check-public-content.py"
spec = importlib.util.spec_from_file_location("public_content", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PublicContentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args])

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def test_keeps_templates_migrations_and_synthetic_fixtures(self):
        for name in (".env.example", "deploy/.deploy.env.example", "server-providers.example.yml", "prisma/migrations/initial/migration.sql", "src/example.test.ts"):
            self.write(name, "synthetic data")
        self.git("add", ".")
        self.assertEqual(checker.inspect_repository(self.root)[1], [])

    def test_checks_new_files_but_does_not_read_ignored_local_credentials(self):
        self.write(".gitignore", ".env.local\n")
        self.write(".env.local", "private-key-marker-not-for-scanning")
        self.write("backups/db.dump", "synthetic backup")
        self.assertEqual(checker.inspect_repository(self.root)[1], [("backups/db.dump", "private-or-generated-path")])

    def test_detects_force_added_private_files_even_when_ignored(self):
        self.write(".gitignore", ".env.local\n")
        self.write(".env.local", "synthetic value")
        self.git("add", "-f", ".env.local")
        findings = checker.inspect_repository(self.root)[1]
        self.assertIn((".env.local", "tracked-but-ignored"), findings)
        self.assertIn((".env.local", "private-or-generated-path"), findings)

    def test_allows_relative_links_to_included_source(self):
        self.write("packages/example/SKILL.md", "source instructions")
        (self.root / "skill").symlink_to("packages/example")
        self.assertEqual(checker.inspect_repository(self.root)[1], [])

    def test_rejects_plaintext_credential_stores_without_relying_on_entropy(self):
        for name in (".netrc", ".git-credentials", ".aws/credentials"):
            self.write(name, "machine example.invalid login synthetic password example")
        findings = checker.inspect_repository(self.root)[1]
        for name in (".netrc", ".git-credentials", ".aws/credentials"):
            self.assertIn((name, "private-or-generated-path"), findings)

    def test_redacts_file_contents_and_rejects_external_symlinks(self):
        marker = "-----BEGIN " + "PRIVATE KEY-----"
        self.write("accidental.txt", marker + "\nSYNTHETIC_DO_NOT_PRINT")
        (self.root / "external").symlink_to("/unavailable/private/file")
        result = subprocess.run(["python3", str(SCRIPT), "--root", str(self.root)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("private-key-marker: accidental.txt", result.stdout)
        self.assertIn("symlink-requires-explicit-review: external", result.stdout)
        self.assertNotIn("SYNTHETIC_DO_NOT_PRINT", result.stdout + result.stderr)
        self.assertNotIn(marker, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
