import { loadConfig } from '../../src/config.js';
import { createKnowledgeStore } from '../../src/storage/factory.js';
import { AtlasService } from '../../src/atlas/service.js';
import type { AtlasServiceLike } from './atlas.js';

/**
 * Build a fully-wired AtlasService from config for the `tuberosa atlas` CLI.
 * Kept out of `atlas.ts` so the command stays unit-testable without a database.
 */
export async function makeAtlasService(): Promise<AtlasServiceLike> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  return new AtlasService(store, { atlasDir: config.atlas.dir ?? '.tuberosa/atlas' });
}
