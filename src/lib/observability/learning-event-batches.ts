import { Histogram, register } from 'prom-client';
import { getOrCreateRegisteredMetric } from './metrics';

export const learningEventBatchSize = getOrCreateRegisteredMetric(register, 'openpbl_learning_event_batch_size', () => new Histogram({
  name: 'openpbl_learning_event_batch_size',
  help: 'Events per schema- and actor-scope-validated learning ingestion attempt, before admission. HTTP replays count again; transaction retries do not. Not a count of committed facts.',
  buckets: [1, 2, 5, 10, 20, 50, 100],
}));
