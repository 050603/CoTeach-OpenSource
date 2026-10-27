// The document status endpoint may return HTTP 200 while work is still queued.
// These helpers govern acceptance transport observation; they do not judge model content.
export const documentAcceptanceReceiptPending = response => response.status === 202
  || response.body?.status === 'processing';
export const documentAcceptancePollTimeout = (startedAt, now = Date.now()) => Math.max(0,
  Math.min(8000, 120000 - (now - startedAt)));
export const documentAcceptanceScenarioCount = (mode, caseCount, repeats) => mode === 'matrix' ? caseCount * repeats : 0;
