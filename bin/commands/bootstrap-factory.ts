import { loadConfig } from '../../src/config.js';
import { createKnowledgeStore } from '../../src/storage/factory.js';
import { createModelProvider } from '../../src/model/factory.js';
import { KnowledgeSafetyService } from '../../src/security/knowledge-safety.js';
import { IngestionService } from '../../src/ingest/service.js';
import { SourceSyncService } from '../../src/source-sync/service.js';
import { AtlasService } from '../../src/atlas/service.js';
import { MaintenanceService } from '../../src/maintenance/service.js';
import { BootstrapService } from '../../src/bootstrap/service.js';
import type { BootstrapServiceLike } from './bootstrap.js';

/**
 * Build a fully-wired BootstrapService from config. The sync service is built
 * with atlasAutoRegen:false because BootstrapService regenerates the atlas
 * explicitly (and, in --deep mode, after graph enrichment).
 */
export async function makeBootstrapService(): Promise<BootstrapServiceLike> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  const models = createModelProvider(config);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.maxIngestContentBytes,
  });
  const atlas = new AtlasService(store, { atlasDir: config.atlasDir ?? '.tuberosa/atlas' });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  return new BootstrapService({
    store,
    sync,
    atlas,
    maintenance: new MaintenanceService(store),
    exportBaseDir: config.exportBaseDir,
  });
}
