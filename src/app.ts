import { Pool } from 'pg';
import { AgentSessionService } from './agent-session/service.js';
import { createCache, type Cache } from './cache.js';
import { loadConfig, type AppConfig } from './config.js';
import { ErrorLogInsightService } from './error-log/insights.js';
import { ErrorLogService } from './error-log/service.js';
import { IngestionService } from './ingest/service.js';
import { createModelProvider, type ModelProvider } from './model/provider.js';
import { OperationsService } from './operations/service.js';
import { ReflectionService } from './reflection/service.js';
import { RetrievalService } from './retrieval/service.js';
import { KnowledgeSafetyService } from './security/knowledge-safety.js';
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
  operations: OperationsService;
  close(): Promise<void>;
}

const CURRENT_SCHEMA_VERSION = 1;

export async function createAppServices(): Promise<AppServices> {
  const config = loadConfig();
  if (config.store === 'memory' && config.env !== 'test') {
    console.error('Tuberosa is running with TUBEROSA_STORE=memory. Knowledge is ephemeral and will disappear when this process exits.');
  }
  await migrateStoreIfNeeded(config);
  const store = createKnowledgeStore(config);
  const cache = await createCache(config);
  const models = createModelProvider(config);
  const safety = new KnowledgeSafetyService();
  const errorLogs = new ErrorLogService({
    rootDir: config.errorLogDir,
    maxBytes: config.errorLogMaxBytes,
    safety,
  });
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.maxIngestContentBytes,
  });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);
  const operations = new OperationsService(store, ingestion, {
    backupDir: config.backupDir,
    storeKind: config.store,
    metadata: {
      appVersion: process.env.npm_package_version ?? '0.1.0',
      appCommit: process.env.TUBEROSA_APP_COMMIT || process.env.GIT_COMMIT || undefined,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      embeddingDimensions: config.embeddingDimensions,
      modelProvider: config.modelProvider,
      embeddingModel: config.openAiEmbeddingModel,
    },
    schedule: {
      enabled: config.backupIntervalSeconds > 0,
      intervalSeconds: config.backupIntervalSeconds,
      startupDelaySeconds: config.backupStartupDelaySeconds,
      retentionCount: config.backupRetentionCount,
      retentionMaxAgeDays: config.backupRetentionMaxAgeDays,
      writeThroughEnabled: config.backupWriteThrough,
      writeThroughThrottleSeconds: config.backupWriteThroughThrottleSeconds,
    },
    physicalMirror: {
      enabled: config.physicalMirrorEnabled,
      dir: config.physicalMirrorDir,
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
    operations,
    async close() {
      await Promise.allSettled([operations.close(), cache.close(), store.close()]);
    },
  };
}

async function migrateStoreIfNeeded(config: AppConfig): Promise<void> {
  if (config.store !== 'postgres' || !config.autoMigrate) {
    return;
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await runMigrations(pool, {
      onApplied: (file) => {
        if (config.env !== 'test') {
          console.error(`Applied database migration ${file}`);
        }
      },
    });
  } finally {
    await pool.end();
  }
}
