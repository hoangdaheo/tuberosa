import { loadConfig } from '../../src/config.js';
import { createKnowledgeStore } from '../../src/storage/factory.js';
import { createModelProvider } from '../../src/model/factory.js';
import { KnowledgeSafetyService } from '../../src/security/knowledge-safety.js';
import { IngestionService } from '../../src/ingest/service.js';
import { SourceSyncService } from '../../src/source-sync/service.js';
import { AtlasService } from '../../src/atlas/service.js';
import type { SyncServiceLike } from './sync.js';

/**
 * Build a fully-wired SourceSyncService from config for the `tuberosa sync` CLI.
 * Kept out of `sync.ts` so the command stays unit-testable without a database.
 */
export async function makeSyncService(): Promise<SyncServiceLike> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  const models = createModelProvider(config);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.maxIngestContentBytes,
  });
  const atlas = new AtlasService(store, { atlasDir: config.atlasDir ?? '.tuberosa/atlas' });
  return new SourceSyncService({ store, ingestion, atlas, atlasAutoRegen: config.atlasAutoRegen ?? true });
}
