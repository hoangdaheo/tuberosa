import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { makeTestConfig } from './support/test-config.js';

const config = makeTestConfig({ context: { cacheTtlSeconds: 0 } });

test('startup brief proceeds and recommends reading current worktree handoff first', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(join(sandbox, 'handoff.md'), '# Current handoff\n\nContinue the retrieval work.\n');
    const { retrieval } = createTestServices();

    const pack = await retrieval.searchContext({
      project: 'startup-brief',
      cwd: sandbox,
      prompt: 'Continue from handoff.md',
      files: ['handoff.md'],
      taskType: 'implementation',
      bypassCache: true,
    });

    const brief = (pack as any).startupBrief;
    equal(brief?.verdict, 'proceed');
    ok(brief?.readFirst?.some((item: { path: string; source: string }) => (
      item.path === 'handoff.md' && item.source === 'worktree'
    )));
    equal(brief?.requiredContextDecision, 'selected');
  } finally {
    destroySandbox(sandbox);
  }
});

test('startup brief clarifies when continuation lacks handoff evidence', async () => {
  const sandbox = createSandbox();
  try {
    const { retrieval } = createTestServices();
    const pack = await retrieval.searchContext({
      project: 'startup-brief',
      cwd: sandbox,
      prompt: 'Continue from handoff',
      taskType: 'implementation',
      bypassCache: true,
    });

    const brief = (pack as any).startupBrief;
    equal(brief?.verdict, 'clarify');
    ok(brief?.missingSignals?.includes('handoff_file'));
    equal(brief?.requiredContextDecision, 'missing_context');
  } finally {
    destroySandbox(sandbox);
  }
});

test('startup brief asks for confirmation when memory and worktree plan headings disagree', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(join(sandbox, 'plan-phase9.md'), '# Phase 9 current plan\n\nShip current retrieval work.\n');
    const { ingestion, retrieval } = createTestServices();
    await ingestion.ingestKnowledge({
      project: 'startup-brief',
      sourceType: 'memory',
      sourceUri: 'memory://phase9-stale',
      itemType: 'memory',
      title: 'Phase 9 stale plan',
      summary: 'Older Phase 9 plan memory.',
      content: 'Phase 9 stale plan described an older direction.',
      labels: [{ type: 'file', value: 'plan-phase9.md', weight: 1 }],
      references: [{ type: 'file', uri: 'plan-phase9.md' }],
    });

    const pack = await retrieval.searchContext({
      project: 'startup-brief',
      cwd: sandbox,
      prompt: 'Continue Phase 9 from plan-phase9.md',
      files: ['plan-phase9.md'],
      taskType: 'implementation',
      bypassCache: true,
    });

    const brief = (pack as any).startupBrief;
    equal(brief?.verdict, 'confirm');
    ok(brief?.missingSignals?.includes('plan_mismatch'));
    equal(brief?.requiredContextDecision, 'selected_but_noisy');
  } finally {
    destroySandbox(sandbox);
  }
});

function createTestServices() {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);

  return { store, cache, models, ingestion, retrieval };
}

function createSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'tuberosa-startup-brief-'));
}

function destroySandbox(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
