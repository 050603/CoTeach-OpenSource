import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function codeScanningDecision(status, body) {
  if (status === 200 && Array.isArray(body)) return { enabled: true, reason: 'available' };
  // An unavailable product is different from a permission/network failure.
  // Never suppress an arbitrary 403, 404, or an unsuccessful analysis/upload.
  const message = typeof body?.message === 'string' ? body.message : '';
  if (status === 403 && /(?:code scanning|code security|advanced security).*(?:not enabled|must be enabled|disabled)/i.test(message)) {
    return { enabled: false, reason: 'feature-disabled' };
  }
  throw new Error(`Cannot verify Code Scanning availability (HTTP ${status}); inspect repository access and GitHub service status.`);
}

export async function checkCodeScanningAvailability({ repository, token, apiUrl = 'https://api.github.com', fetcher = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required for the Code Scanning availability check.');
  }
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/repos/${repository}/code-scanning/analyses?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  return codeScanningDecision(response.status, body);
}

async function main() {
  const decision = await checkCodeScanningAvailability({ repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `enabled=${decision.enabled}\n`);
  const summary = decision.enabled
    ? 'Code Scanning is available. The dependent CodeQL job will run analysis and upload; both must succeed.\n'
    : 'CodeQL is NOT APPLICABLE: GitHub explicitly reports Code Scanning is disabled. No CodeQL initialization, analysis or upload was run. Private repositories require the appropriate GitHub Code Security entitlement; public open-source repositories can enable the supported workflow. Other CI, dependency and public-content checks still run independently.\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // API bodies and request details may contain sensitive data. Report a fixed
    // failure message rather than dumping responses, environment or tokens.
    console.error('Code Scanning availability is unknown; CodeQL analysis was not authorized by this check. Inspect credentials, API access and service availability.');
    process.exitCode = 1;
  });
}
