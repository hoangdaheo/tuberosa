import { Pool } from 'pg';
import { AgentSessionService } from './agent-session/service.js';
import { createCache, type Cache } from './cache.js';
import { loadConfig, type AppConfig } from './config.js';
import { CurationService } from './curation/service.js';
import { ErrorLogInsightService } from './error-log/insights.js';
import { ErrorLogService } from './error-log/service.js';
import { IngestionService } from './ingest/service.js';
import { MaintenanceService } from './maintenance/service.js';
import { assertModelsReady } from './model/health.js';
import { createModelProvider } from './model/factory.js';
import type { ModelProvider } from './model/provider.js';
import { OperationsService } from './operations/service.js';
import { SessionReplayService } from './operations/session-replay.js';
import { ReflectionService } from './reflection/service.js';
import { RetrievalService } from './retrieval/service.js';
import { KnowledgeSafetyService } from './security/knowledge-safety.js';
import { validateEmbeddingDimensions } from './storage/embedding-dimensions.js';
import { createKnowledgeStore } from './storage/factory.js';
import { runMigrations } from './storage/migrations.js';
import type { KnowledgeStore } from './storage/store.js';

export interface AppServices {
  config: AppConfig;
  cache: Cache;
  store: KnowledgeStore;
  models: ModelProvider;
  safety: KnowledgeSafetyService;
  errorLogs: ErrorLogService;
  errorLogInsights: ErrorLogInsightService;
  ingestion: IngestionService;
  retrieval: RetrievalService;
  reflection: ReflectionService;
  agentSessions: AgentSessionService;
  sessionReplay: SessionReplayService;
  operations: OperationsService;
  maintenance: MaintenanceService;
  curation: CurationService;
  close(): Promise<void>;
}

const CURRENT_SCHEMA_VERSION = 2;

export async function createAppServices(): Promise<AppServices> {
  const config = loadConfig();
  if (config.storage.store === 'memory' && config.env !== 'test') {
    console.error('Tuberosa is running with TUBEROSA_STORE=memory. Knowledge is ephemeral and will disappear when this process exits.');
  }
  await migrateStoreIfNeeded(config);
  const store = createKnowledgeStore(config);
  const cache = await createCache(config);
  const models = createModelProvider(config);
  await assertModelsReady(models, config);
  const safety = new KnowledgeSafetyService();
  const errorLogs = new ErrorLogService({
    rootDir: config.errorLog.dir,
    maxBytes: config.errorLog.maxBytes,
    safety,
  });
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.ingest.maxContentBytes,
  });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const sessionReplay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(store, retrieval, reflection, models, sessionReplay, config, cache);
  const maintenance = new MaintenanceService(store);
  const curation = new CurationService(store);
  const operations = new OperationsService(store, ingestion, {
    backupDir: config.backup.dir,
    storeKind: config.storage.store,
    metadata: {
      appVersion: process.env.npm_package_version ?? '0.1.0',
      appCommit: process.env.TUBEROSA_APP_COMMIT || process.env.GIT_COMMIT || undefined,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      embeddingDimensions: config.model.embeddingDimensions,
      modelProvider: config.model.provider,
      embeddingModel: config.model.openAiEmbeddingModel,
    },
    schedule: {
      enabled: config.backup.intervalSeconds > 0,
      intervalSeconds: config.backup.intervalSeconds,
      startupDelaySeconds: config.backup.startupDelaySeconds,
      retentionCount: config.backup.retentionCount,
      retentionMaxAgeDays: config.backup.retentionMaxAgeDays,
      writeThroughEnabled: config.backup.writeThrough,
      writeThroughThrottleSeconds: config.backup.writeThroughThrottleSeconds,
    },
    physicalMirror: {
      enabled: config.mirror.enabled,
      dir: config.mirror.dir,
      debounceMs: config.mirror.debounceMs,
    },
  });

  return {
    config,
    cache,
    store,
    models,
    safety,
    errorLogs,
    errorLogInsights,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    maintenance,
    curation,
    async close() {
      await Promise.allSettled([operations.close(), cache.close(), store.close()]);
    },
  };
}

async function migrateStoreIfNeeded(config: AppConfig): Promise<void> {
  if (config.storage.store !== 'postgres') {
    return;
  }

  const pool = new Pool({ connectionString: config.storage.databaseUrl });
  try {
    if (config.storage.autoMigrate) {
      await runMigrations(pool, {
        onApplied: (file) => {
          if (config.env !== 'test') {
            console.error(`Applied database migration ${file}`);
          }
        },
      });
    }
    await validateEmbeddingDimensions(pool, config.model.embeddingDimensions);
  } finally {
    await pool.end();
  }
}
