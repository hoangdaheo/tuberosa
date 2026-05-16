import { AgentSessionService } from './agent-session/service.js';
import { createCache, type Cache } from './cache.js';
import { loadConfig, type AppConfig } from './config.js';
import { IngestionService } from './ingest/service.js';
import { createModelProvider, type ModelProvider } from './model/provider.js';
import { OperationsService } from './operations/service.js';
import { ReflectionService } from './reflection/service.js';
import { RetrievalService } from './retrieval/service.js';
import { KnowledgeSafetyService } from './security/knowledge-safety.js';
import { createKnowledgeStore } from './storage/factory.js';
import type { KnowledgeStore } from './storage/store.js';

export interface AppServices {
  config: AppConfig;
  cache: Cache;
  store: KnowledgeStore;
  models: ModelProvider;
  safety: KnowledgeSafetyService;
  ingestion: IngestionService;
  retrieval: RetrievalService;
  reflection: ReflectionService;
  agentSessions: AgentSessionService;
  operations: OperationsService;
  close(): Promise<void>;
}

export async function createAppServices(): Promise<AppServices> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  const cache = await createCache(config);
  const models = createModelProvider(config);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.maxIngestContentBytes,
  });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);
  const operations = new OperationsService(store, ingestion);

  return {
    config,
    cache,
    store,
    models,
    safety,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    operations,
    async close() {
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}
