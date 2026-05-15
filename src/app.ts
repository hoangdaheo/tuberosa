import { createCache, type Cache } from './cache.js';
import { loadConfig, type AppConfig } from './config.js';
import { IngestionService } from './ingest/service.js';
import { createModelProvider, type ModelProvider } from './model/provider.js';
import { ReflectionService } from './reflection/service.js';
import { RetrievalService } from './retrieval/service.js';
import { createKnowledgeStore } from './storage/factory.js';
import type { KnowledgeStore } from './storage/store.js';

export interface AppServices {
  config: AppConfig;
  cache: Cache;
  store: KnowledgeStore;
  models: ModelProvider;
  ingestion: IngestionService;
  retrieval: RetrievalService;
  reflection: ReflectionService;
  close(): Promise<void>;
}

export async function createAppServices(): Promise<AppServices> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  const cache = await createCache(config);
  const models = createModelProvider(config);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);

  return {
    config,
    cache,
    store,
    models,
    ingestion,
    retrieval,
    reflection,
    async close() {
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}
