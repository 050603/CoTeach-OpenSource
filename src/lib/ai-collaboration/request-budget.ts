// Reasoning models need time to complete both generation and review. Keep the
// transport and database lease alive long enough to receive the durable result.
export const COLLABORATION_EXECUTION_TIMEOUT_MS = 110_000;
export const COLLABORATION_BROWSER_TIMEOUT_MS = 120_000;
export const COLLABORATION_REQUEST_LEASE_MS = 125_000;

// Interactive document work can include assessment, generation and review.
// Its HTTP acknowledgement is short; the persisted task has a separate budget.
export const DOCUMENT_COLLABORATION_EXECUTION_TIMEOUT_MS = 300_000;
export const DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS = 320_000;
export const DOCUMENT_COLLABORATION_REQUEST_LEASE_MS = 335_000;
