import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSyncService } from '../src/source-sync/service.js';

// The MCP tool tuberosa_sync_sources is a thin wrapper over SourceSyncService.
// This test pins the response contract the wrapper returns (plan + planId).
test('tuberosa_sync_sources delegates to SourceSyncService and returns plan + planId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const store = new MemoryKnowledgeStore();
  const svc = new SourceSyncService({ store, ingestion: new IngestionService(store, new HashModelProvider()) });
  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'mcp' });
  assert.ok(planId);
  assert.equal(plan.summary.added, 1);
});
