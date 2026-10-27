/** Diagnostic summaries only; no document content, request IDs or identity. */
export type PendingSaveTelemetry = {
  clientId?: string;
  known: boolean;
  count?: number;
  oldestCreatedAt?: number | null;
};
