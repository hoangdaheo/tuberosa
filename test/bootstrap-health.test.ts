import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { buildBootstrapHealthSummary } from '../src/bootstrap/health.js';

test('buildBootstrapHealthSummary: counts sources, conflicts, gaps', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a.ts', contentHash: 'h1' });
  await store.upsertSourceFile({ project: 'p', path: 'src/b.ts', contentHash: 'h2' });

  const health = await buildBootstrapHealthSummary(
    { store, maintenance: new MaintenanceService(store) },
    { project: 'p' },
  );

  assert.equal(health.sourceCounts.tracked, 2);
  assert.equal(health.openImportConflicts, 0);
  assert.equal(health.gaps, 0);
  assert.equal(health.maintenanceItems, 0);
});

test('buildBootstrapHealthSummary: maintenance is optional', async () => {
  const store = new MemoryKnowledgeStore();
  const health = await buildBootstrapHealthSummary({ store }, { project: 'p' });
  assert.equal(health.maintenanceItems, 0);
});
