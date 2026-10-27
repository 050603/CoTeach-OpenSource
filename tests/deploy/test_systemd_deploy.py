"""Exercise deployment failure boundaries without touching services or a remote host."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/deploy-systemd.sh'
SHA = 'a' * 40
BUILD_ID = 'fixture-build'


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'commands.log'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        fake = '''#!/usr/bin/env bash
set -eu
name=${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$TEST_LOG"
case "$name:$1" in
  git:rev-parse)
    case "$2" in
      --show-toplevel) pwd ;;
      --git-path) printf '%s/lock\\n' "$PWD" ;;
      HEAD) printf '%040d\\n' 0 ;;
    esac ;;
  git:status) printf '%s' "${TEST_DIRTY:-}" ;;
  systemctl:--user)
    if [ "$2" = show ]; then
      case "$*" in
        *--property=WorkingDirectory*) pwd ;;
        *--property=Environment*) printf '%s\\n' "${TEST_SERVICE_ENVIRONMENT:-}" ;;
      esac
    fi ;;
  pnpm:build)
    if [ "${TEST_MISSING_BUILD_ID:-0}" != 1 ]; then
      mkdir -p .next-build
      printf 'fixture-build\\n' > .next-build/BUILD_ID
    fi
    exit "${TEST_BUILD_EXIT:-0}" ;;
  node:scripts/lib/production-runtime-release.mjs) exit "${TEST_PREPARED_EXIT:-0}" ;;
  python3:scripts/setup-survey-nlp.py) exit "${TEST_NLP_EXIT:-0}" ;;
  python3:-c) exec "$TEST_REAL_PYTHON" "$@" ;;
  curl:*)
    case "$*" in
      *'/vendor/pdfjs/pdf.worker.legacy.min.mjs')
        printf '%s %s' "${TEST_WORKER_STATUS:-200}" "${TEST_WORKER_MIME:-application/javascript}"
        exit "${TEST_WORKER_EXIT:-0}" ;;
      *'/vendor/pdfjs/pdf.legacy.min.mjs')
        printf '%s %s' "${TEST_PDF_STATUS:-200}" "${TEST_PDF_MIME:-application/javascript}"
        exit "${TEST_PDF_EXIT:-0}" ;;
    esac
    exit "${TEST_HEALTH_EXIT:-0}" ;;
  flock:*) exit "${TEST_LOCK_EXIT:-0}" ;;
esac
'''
        for command in ['git', 'pnpm', 'node', 'python3', 'systemctl', 'curl', 'sleep', 'flock']:
            p = bin_dir / command
            p.write_text(fake)
            p.chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                    'TEST_LOG': str(self.log), 'TEST_REAL_PYTHON': sys.executable}

    def run_deploy(self, sha=SHA, **env):
        result = subprocess.run(['bash', str(SCRIPT), sha, str(self.root)],
                                env={**self.env, **env}, text=True, capture_output=True)
        calls = self.log.read_text() if self.log.exists() else ''
        return result, calls

    def test_verified_revision_becomes_healthy(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'git checkout --detach {SHA}', calls)
        self.assertIn('Healthy deployment:', result.stdout)
        self.assertLess(calls.index('pnpm build'), calls.index('systemctl --user restart'))
        prepared = f'node scripts/lib/production-runtime-release.mjs {self.root} {BUILD_ID}'
        self.assertLess(calls.index('pnpm build'), calls.index(prepared))
        self.assertLess(calls.index(prepared), calls.index('systemctl --user restart'))
        self.assertLess(calls.index('--property=Environment'), calls.index('systemctl --user restart'))
        self.assertIn('openpbl-survey-nlp.service', calls)
        self.assertIn('http://127.0.0.1:3003/health/live', calls)
        self.assertIn('/vendor/pdfjs/pdf.legacy.min.mjs', calls)
        self.assertIn('/vendor/pdfjs/pdf.worker.legacy.min.mjs', calls)

    def test_incomplete_prepared_release_preserves_running_services(self):
        result, calls = self.run_deploy(TEST_PREPARED_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('systemctl --user restart', calls)
        self.assertNotIn('Healthy deployment:', result.stdout)

    def test_missing_build_identity_preserves_running_services(self):
        result, calls = self.run_deploy(TEST_MISSING_BUILD_ID='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('systemctl --user restart', calls)

    def test_different_or_empty_explicit_runtime_pin_preserves_running_services(self):
        for pin in ['older-build', '']:
            with self.subTest(pin=pin):
                result, calls = self.run_deploy(
                    TEST_SERVICE_ENVIRONMENT=f'OPENPBL_RUNTIME_BUILD_ID={pin} SECRET=do-not-print')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('OPENPBL_RUNTIME_BUILD_ID', result.stderr)
                self.assertNotIn('systemctl --user restart', calls)
                self.assertNotIn('Healthy deployment:', result.stdout)
                self.assertNotIn('do-not-print', result.stdout + result.stderr + calls)

    def test_matching_quoted_runtime_pin_can_be_deployed(self):
        result, calls = self.run_deploy(
            TEST_SERVICE_ENVIRONMENT=f'"OPENPBL_RUNTIME_BUILD_ID={BUILD_ID}" "SECRET=do not print"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Healthy deployment:', result.stdout)
        self.assertNotIn('do not print', result.stdout + result.stderr + calls)

    def test_invalid_environment_output_preserves_running_services(self):
        result, calls = self.run_deploy(TEST_SERVICE_ENVIRONMENT='SECRET="unterminated')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('systemctl --user restart', calls)
        self.assertNotIn('unterminated', result.stdout + result.stderr + calls)

    def test_failed_local_model_setup_preserves_running_services(self):
        result, calls = self.run_deploy(TEST_NLP_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('pnpm build', calls)
        self.assertNotIn('systemctl --user restart', calls)

    def test_dirty_checkout_is_preserved(self):
        result, calls = self.run_deploy(TEST_DIRTY=' M user-work.ts')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('git checkout', calls)
        self.assertNotIn('pnpm install', calls)

    def test_failed_build_does_not_restart_live_services(self):
        result, calls = self.run_deploy(TEST_BUILD_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('systemctl --user restart', calls)

    def test_failed_health_is_not_reported_as_success(self):
        result, calls = self.run_deploy(TEST_HEALTH_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Healthy deployment:', result.stdout)
        self.assertEqual(calls.count('curl --fail'), 60)

    def test_failed_browser_asset_checks_are_not_reported_as_healthy(self):
        for env in [
            {'TEST_PDF_EXIT': '22'},
            {'TEST_PDF_MIME': 'text/html'},
            {'TEST_PDF_STATUS': '302'},
            {'TEST_WORKER_EXIT': '22'},
            {'TEST_WORKER_MIME': 'application/octet-stream'},
        ]:
            with self.subTest(env=env):
                result, calls = self.run_deploy(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Healthy deployment:', result.stdout)
                self.assertIn('Deployment health check failed', result.stderr)

    def test_javascript_mime_parameters_are_accepted(self):
        result, _calls = self.run_deploy(TEST_PDF_MIME='text/javascript; charset=UTF-8',
                                        TEST_WORKER_MIME='application/javascript; charset=UTF-8')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_busy_checkout_is_not_updated(self):
        result, calls = self.run_deploy(TEST_LOCK_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('git fetch', calls)

    def test_invalid_revision_does_not_execute_commands(self):
        result, calls = self.run_deploy(sha='main; echo unexpected')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
