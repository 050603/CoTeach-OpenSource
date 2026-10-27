import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Gauge } from 'prom-client';
import { prisma } from '@/lib/db/client';
import { classroomDesignCacheSnapshot } from '@/lib/db/classroom-design-cache';
import { readAiAuditOutboxCounts } from '@/lib/ai-collaboration/audit-outbox';
import { classroomAiCapacitySnapshot } from '@/lib/llm/classroom-capacity';
import { documentConversionHealth } from '@/lib/project-practice/document-conversion-pool';
import { documentReviewWorkerSnapshot } from '@/lib/ai-collaboration/document-review-worker';
import { register, getOrCreateRegisteredMetric } from './metrics';
import { pendingSaveReportSnapshot } from './pending-save-reports';

const gauge = (name: string, help: string) => getOrCreateRegisteredMetric(register, name,
  () => new Gauge({ name, help }));
getOrCreateRegisteredMetric(register, 'openpbl_published_design_cache', () => new Gauge({
  name: 'openpbl_published_design_cache', help: 'Bounded published classroom design cache entries, pending reads and retained serialized bytes.',
  labelNames: ['kind'] as const,
  collect() { for (const [kind, count] of Object.entries(classroomDesignCacheSnapshot())) this.labels(kind).set(count); },
}));
const connections = gauge('openpbl_postgres_connections', 'Client backend sessions across the PostgreSQL cluster, including this sample connection; excludes internal/background and replication backends. NaN if backend types are hidden or collection fails.');
const limit = gauge('openpbl_postgres_connection_limit', 'Configured PostgreSQL max_connections, including reserved slots; not an application pool limit.');
const waiting = gauge('openpbl_postgres_lock_waiters', 'PostgreSQL server processes waiting for a heavyweight Lock across all backend types; NaN when backend visibility is incomplete or collection fails.');
const activeAi = gauge('openpbl_classroom_ai_active', 'Active classroom model calls.');
const pendingAi = gauge('openpbl_classroom_ai_pending', 'Interactive model calls waiting for capacity.');
const pendingAudit = gauge('openpbl_ai_audit_outbox_pending', 'Durable audit batches awaiting database replay.');
const quarantinedAudit = gauge('openpbl_ai_audit_outbox_quarantined', 'Invalid audit batches preserved for investigation and repair.');
const backupAt = gauge('openpbl_local_backup_checkpoint_timestamp_seconds', 'Latest recoverable local database/files checkpoint.');
const available = getOrCreateRegisteredMetric(register, 'openpbl_health_sample_available', () => new Gauge({
  name: 'openpbl_health_sample_available', help: 'Whether the latest dependency telemetry sample is available; unavailable values are NaN, never a fabricated zero.',
  labelNames: ['component'] as const,
}));
const conversionReady = gauge('openpbl_document_conversion_workers_ready', 'Ready document conversion worker threads.');
const conversionBusy = gauge('openpbl_document_conversion_workers_busy', 'Document conversion worker threads executing conversions.');
const conversionQueued = gauge('openpbl_document_conversion_queued', 'Document conversions waiting for an existing worker.');
const conversionHealthy = gauge('openpbl_document_conversion_healthy', 'Whether the initialized document conversion pool is healthy (unknown outside production).');
const reviewEnabled = gauge('openpbl_document_review_worker_enabled', 'Whether shared document/code background worker execution is required in this production process (legacy metric name).');
const reviewHeartbeat = gauge('openpbl_document_review_worker_heartbeat_timestamp_seconds', 'Most recent successful durable review scheduler tick; NaN until observed.');
const reviewHealthy = gauge('openpbl_document_review_worker_healthy', 'Whether the enabled review scheduler has a successful recent tick.');
const reviewActive = gauge('openpbl_document_review_worker_active', 'Reviews executing in this application process.');
const reviewQueued = gauge('openpbl_document_review_queued', 'Durable pending reviews at the most recent successful scheduler tick; NaN when unavailable.');
const reviewOldest = gauge('openpbl_document_review_oldest_pending_timestamp_seconds', 'Creation time of the oldest PENDING or RUNNING durable review (legacy metric name); NaN when unknown or none.');
const pendingSaveCount = gauge('openpbl_pending_save_count', 'Pending/conflicting submission saves self-reported by observed browser profiles in this process; NaN when any report is unknown, not a server durability count.');
const pendingSaveAge = gauge('openpbl_pending_save_oldest_age_seconds', 'Age of the oldest observed browser pending save; explicit empty reports are zero, unavailable/restarted/expired reports are NaN.');
const pendingSaveAvailable = gauge('openpbl_pending_save_sample_available', 'Whether every observed browser-profile pending-save summary is fresh and known; zero means unavailable, not no pending work.');
const pendingSaveClients = gauge('openpbl_pending_save_clients', 'Bounded browser-profile/course report entries observed in this process; no identity labels.');
const pendingSaveUnknown = gauge('openpbl_pending_save_unknown_clients', 'Observed browser-profile reports that are unknown or expired; NaN if the bounded registry overflowed.');
const pendingSaveKnownCount = gauge('openpbl_pending_save_known_count', 'Lower bound from fresh known browser-profile reports only; unknown/expired clients excluded, zero does not prove no pending saves.');
const pendingSaveKnownAge = gauge('openpbl_pending_save_known_oldest_age_seconds', 'Age of the oldest pending save in fresh known reports; a lower bound on the global oldest age, NaN when none is known.');

export async function refreshClassroomHealthMetrics(): Promise<void> {
  const saves = pendingSaveReportSnapshot();
  pendingSaveAvailable.set(Number(saves.known)); pendingSaveClients.set(saves.clients); pendingSaveUnknown.set(saves.unknownClients);
  pendingSaveCount.set(saves.count);
  pendingSaveAge.set(saves.known ? saves.oldestCreatedAt === null ? 0 : Math.max(0, (Date.now() - saves.oldestCreatedAt) / 1000) : Number.NaN);
  pendingSaveKnownCount.set(saves.knownCount);
  pendingSaveKnownAge.set(saves.oldestKnownCreatedAt === null ? Number.NaN : Math.max(0, (Date.now() - saves.oldestKnownCreatedAt) / 1000));
  const ai = classroomAiCapacitySnapshot();
  activeAi.set(ai.active); pendingAi.set(ai.pending);
  const conversion = documentConversionHealth();
  conversionReady.set(conversion.ready); conversionBusy.set(conversion.busy); conversionQueued.set(conversion.queued);
  conversionHealthy.set(process.env.NODE_ENV === 'production' ? Number(conversion.ok) : Number.NaN);
  const review = documentReviewWorkerSnapshot();
  const enabled = process.env.NODE_ENV === 'production';
  const reviewSampleKnown = review.initialized && review.lastTickAt !== null && Date.now() - review.lastTickAt < 30_000
    && (!review.lastErrorAt || review.lastErrorAt <= review.lastTickAt);
  reviewEnabled.set(Number(enabled));
  reviewHeartbeat.set(review.lastTickAt === null ? Number.NaN : review.lastTickAt / 1000);
  reviewHealthy.set(enabled ? Number(review.running && reviewSampleKnown && Date.now() - review.lastTickAt! < 30_000) : Number.NaN);
  reviewActive.set(review.active);
  reviewQueued.set(reviewSampleKnown ? review.queued : Number.NaN);
  reviewOldest.set(reviewSampleKnown && review.oldestQueuedAt ? review.oldestQueuedAt / 1000 : Number.NaN);
  available.labels('document-review').set(enabled ? Number(reviewSampleKnown) : Number.NaN);
  const [database, backup, outbox] = await Promise.allSettled([
    prisma.$queryRaw<Array<{ connections: bigint | null; waiting: bigint; max: number }>>`
      SELECT CASE WHEN count(*) FILTER (WHERE backend_type IS NULL) = 0
        THEN count(*) FILTER (WHERE backend_type = 'client backend') END AS connections,
        count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting,
        current_setting('max_connections')::int AS max
      FROM pg_stat_activity`,
    readFile(process.env.LOCAL_BACKUP_STATUS_FILE || path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', '../local-backup/status/last-success.json'), 'utf8'),
    readAiAuditOutboxCounts(),
  ]);
  pendingAudit.set(outbox.status === 'fulfilled' ? outbox.value.pending : Number.NaN);
  quarantinedAudit.set(outbox.status === 'fulfilled' ? outbox.value.quarantined : Number.NaN);
  available.labels('audit').set(Number(outbox.status === 'fulfilled'));
  if (database.status === 'fulfilled' && database.value[0]) {
    const row = database.value[0];
    connections.set(row.connections === null ? Number.NaN : Number(row.connections)); waiting.set(row.connections === null ? Number.NaN : Number(row.waiting)); limit.set(row.max);
    available.labels('database').set(Number(row.connections !== null));
  } else { connections.set(Number.NaN); waiting.set(Number.NaN); limit.set(Number.NaN); available.labels('database').set(0); }
  let backupEpoch = Number.NaN;
  if (backup.status === 'fulfilled') {
    try {
      const status = JSON.parse(backup.value);
      const epoch = Number(status.startedEpoch);
      if (Number.isFinite(epoch) && epoch > 0 && epoch <= Date.now() / 1000) backupEpoch = epoch;
    } catch { /* Keep a missing or corrupt checkpoint unknown. */ }
  }
  backupAt.set(backupEpoch);
  available.labels('backup').set(Number(Number.isFinite(backupEpoch)));
}
