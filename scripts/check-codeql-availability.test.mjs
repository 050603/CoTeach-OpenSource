import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { checkCodeScanningAvailability, codeScanningDecision } from './check-codeql-availability.mjs';

test('an enabled repository permits analysis even before its first analysis', () => {
  assert.deepEqual(codeScanningDecision(200, []), { enabled: true, reason: 'available' });
});

test('only the documented disabled-product response marks the analysis inapplicable', () => {
  for (const message of ['Advanced Security must be enabled for this repository to use code scanning.',
    'GitHub Code Security or GitHub Advanced Security is not enabled', 'Code scanning is not enabled for this repository']) {
    assert.deepEqual(codeScanningDecision(403, { message }), { enabled: false, reason: 'feature-disabled' });
  }
  for (const [status, body] of [[401, { message: 'Bad credentials' }],
    [403, { message: 'Resource not accessible by integration' }], [403, { message: 'API rate limit exceeded' }],
    [404, { message: 'Not Found' }], [500, { message: 'Advanced Security must be enabled' }], [200, {}]]) {
    assert.throws(() => codeScanningDecision(status, body), /Cannot verify Code Scanning/);
  }
});

test('the probe uses a read-only authenticated endpoint and propagates transport failure', async () => {
  const decision = await checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/fixture/project/code-scanning/analyses?per_page=1');
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      return { status: 200, json: async () => [] };
    } });
  assert.equal(decision.enabled, true);
  await assert.rejects(checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
    fetcher: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
});

test('the workflow gates initialization and keeps SARIF without ignoring actual failures', async () => {
  const workflow = await readFile(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');
  assert.match(workflow, /needs: applicability/);
  assert.match(workflow, /if: needs\.applicability\.outputs\.enabled == 'true'/);
  assert.ok(workflow.indexOf('node scripts/check-codeql-availability.mjs') < workflow.indexOf('github/codeql-action/init@'));
  assert.match(workflow, /if: always\(\) && hashFiles\('codeql-results\/\*\*\/\*\.sarif'\)/);
  assert.doesNotMatch(workflow, /continue-on-error|upload: never/);
});
