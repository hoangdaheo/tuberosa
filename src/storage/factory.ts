import type { AppConfig } from '../config.js';
import { MemoryKnowledgeStore } from './memory-store.js';
import { PostgresKnowledgeStore } from './postgres-store.js';
import type { KnowledgeStore } from './store.js';

export function createKnowledgeStore(config: AppConfig): KnowledgeStore {
  if (config.storage.store === 'memory') {
    return new MemoryKnowledgeStore();
  }

  return new PostgresKnowledgeStore(config.storage.databaseUrl);
}
