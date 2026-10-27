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
    [404, { message: 'Not Found' }], [404, { message: 'no analysis found' }],
    [500, { message: 'Advanced Security must be enabled' }], [200, {}]]) {
    assert.throws(() => codeScanningDecision(status, body), /Cannot verify Code Scanning/);
  }
});

test('a first analysis starts only after the authenticated repository API confirms the public repository', async () => {
  const calls = [];
  const decision = await checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(options.method, undefined);
      return url.endsWith('/analyses?per_page=1')
        ? { status: 404, json: async () => ({ message: 'no analysis found' }) }
        : { status: 200, json: async () => ({ full_name: 'fixture/project', private: false, visibility: 'public' }) };
    } });
  assert.deepEqual(decision, { enabled: true, reason: 'public-first-analysis' });
  assert.deepEqual(calls, ['https://api.github.com/repos/fixture/project/code-scanning/analyses?per_page=1',
    'https://api.github.com/repos/fixture/project']);
});

test('an absent first analysis cannot authorize private, internal, different or inaccessible repositories', async () => {
  for (const [status, metadata] of [
    [200, { full_name: 'fixture/project', private: true, visibility: 'private' }],
    [200, { full_name: 'fixture/project', private: false, visibility: 'internal' }],
    [200, { full_name: 'another/project', private: false, visibility: 'public' }],
    [401, { message: 'Bad credentials' }], [403, { message: 'Resource not accessible by integration' }],
    [404, { message: 'Not Found' }], [200, null],
  ]) {
    await assert.rejects(checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
      fetcher: async (url) => url.endsWith('/analyses?per_page=1')
        ? { status: 404, json: async () => ({ message: 'no analysis found' }) }
        : { status, json: async () => metadata } }), /Cannot verify Code Scanning/);
  }
});

test('first-analysis metadata transport failures remain errors', async () => {
  await assert.rejects(checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
    fetcher: async (url) => {
      if (url.endsWith('/analyses?per_page=1')) return { status: 404, json: async () => ({ message: 'no analysis found' }) };
      throw new Error('metadata network unavailable');
    } }), /metadata network unavailable/);
});

test('a public GitHub Enterprise endpoint does not imply GitHub.com public CodeQL entitlement', async () => {
  await assert.rejects(checkCodeScanningAvailability({ repository: 'fixture/project', token: 'synthetic-token',
    apiUrl: 'https://github.example.com/api/v3', fetcher: async (url) => {
      assert.equal(url, 'https://github.example.com/api/v3/repos/fixture/project/code-scanning/analyses?per_page=1');
      return { status: 404, json: async () => ({ message: 'no analysis found' }) };
    } }), /Cannot verify Code Scanning/);
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
