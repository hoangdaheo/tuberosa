/**
 * Generate canned replay JSON files for each acmeBilling prompt.
 *
 * Each file at src/workbench-v2/data/demo/replays/<promptId>.json contains a
 * compact shape consumed by Ch07_TryIt:
 *   - classifier: { symbols, errors, files, businessAreas, technologies, taskType }
 *   - timings: { totalMs, stageMs }
 *   - pack: { essential, supporting, optional } each [{id, title, tokens}]
 *   - contextFit
 *   - sourceCounts: per-source candidate counts (for SignalChips/PipelineFlow detail)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type {
  ContextPack,
  ContextSearchInput,
  KnowledgeInput,
  RetrievalDebugTrace,
} from '../src/types.js';
import {
  acmeBilling,
  type BranchTag,
  type SeedFixture,
} from '../src/workbench-v2/data/fixtures.js';

const TEST_CONFIG: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  httpHost: '127.0.0.1',
  requireApiKeyForNonLoopback: false,
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: false,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

function seedToInput(item: SeedFixture['items'][number], project: string): KnowledgeInput {
  return {
    project,
    sourceType: 'fixture',
    sourceUri: item.sourceUri,
    itemType: item.itemType as KnowledgeInput['itemType'],
    title: item.title,
    summary: item.content.slice(0, 200),
    content: item.content,
    trustLevel: 95,
    labels: item.labels ?? [],
    references: item.references ?? [],
    freshnessAt: item.freshnessAt,
    metadata: {},
  };
}

interface ReplayDoc {
  classifier: {
    symbols: string[];
    errors: string[];
    files: string[];
    businessAreas: string[];
    technologies: string[];
    taskType?: string;
  };
  timings: { totalMs: number; stageMs: Record<string, number> };
  pack: {
    essential: Array<{ id: string; title: string; tokens: number }>;
    supporting: Array<{ id: string; title: string; tokens: number }>;
    optional: Array<{ id: string; title: string; tokens: number }>;
  };
  contextFit: { fitStatus: string; missingSignals?: string[] };
  sourceCounts: Record<string, number>;
}

function toReplay(pack: ContextPack): ReplayDoc {
  const debug = pack.debug as RetrievalDebugTrace | undefined;
  const sections = pack.sections ?? [];
  const section = (name: string) =>
    sections.find((s) => s.name === name)?.items.map((it) => ({
      id: it.knowledgeId,
      title: it.title ?? '',
      tokens: it.tokenEstimate ?? Math.ceil((it.content?.length ?? 0) / 4),
    })) ?? [];
  const stageMs: Record<string, number> = {};
  if (debug?.timingsMs) {
    for (const [k, v] of Object.entries(debug.timingsMs)) {
      if (typeof v === 'number') stageMs[k] = v;
    }
  }
  const sourceCounts: Record<string, number> = {};
  for (const stage of debug?.stages ?? []) {
    sourceCounts[stage.name] = stage.candidateCount;
  }
  const c = pack.classified;
  return {
    classifier: {
      symbols: c?.symbols ?? [],
      errors: c?.errors ?? [],
      files: c?.files ?? [],
      businessAreas: c?.businessAreas ?? [],
      technologies: c?.technologies ?? [],
      taskType: c?.taskType,
    },
    timings: {
      totalMs: Object.values(stageMs).reduce((a, b) => a + b, 0),
      stageMs,
    },
    pack: {
      essential: section('essential'),
      supporting: section('supporting'),
      optional: section('optional'),
    },
    contextFit: {
      fitStatus: pack.contextFit?.fitStatus ?? 'insufficient',
      missingSignals: pack.contextFit?.missingSignals,
    },
    sourceCounts,
  };
}

async function main(): Promise<void> {
  const fixture = acmeBilling;
  const project = fixture.project;
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider(TEST_CONFIG.embeddingDimensions);
  const cache = new MemoryCache();
  const idMap = new Map<string, string>();

  for (const item of fixture.items) {
    const input = seedToInput(item, project);
    const embedding = await models.embed(`${input.title} ${input.content}`);
    const stored = await store.upsertKnowledge(input, [
      {
        index: 0,
        content: input.content,
        contextualContent: `${input.title}\n\n${input.content}`,
        tokenEstimate: Math.ceil(input.content.length / 4),
        embedding,
      },
    ]);
    idMap.set(item.id, stored.id);
  }

  for (const rel of fixture.relations ?? []) {
    const fromId = idMap.get(rel.fromId);
    const toId = idMap.get(rel.toId);
    if (!fromId || !toId) continue;
    await store.createKnowledgeRelation({
      project,
      fromKnowledgeId: fromId,
      relationType: rel.kind as 'depends_on' | 'related_to' | 'supersedes',
      targetKind: 'knowledge',
      targetKnowledgeId: toId,
      confidence: 0.9,
    });
  }

  const service = new RetrievalService(store, cache, models, TEST_CONFIG);

  // Warm-up for memory_boost prompts (mirrors demo-fixture test).
  const boostIds = new Set(
    fixture.prompts
      .filter((p) => (p.branches as BranchTag[]).includes('adjust:memory_boost'))
      .map((p) => p.id),
  );
  for (const p of fixture.prompts) {
    if (!boostIds.has(p.id)) continue;
    const warmup = await service.searchContext({
      project,
      prompt: p.text,
      debug: false,
      bypassCache: true,
    });
    if (warmup.id) {
      await store.recordFeedback({
        project,
        feedbackType: 'selected',
        contextPackId: warmup.id,
      });
    }
  }

  for (const p of fixture.prompts) {
    const isStrict = (p.branches as BranchTag[]).includes('mode:strict_noise');
    const isLayered = (p.branches as BranchTag[]).includes('mode:layered_deep_context');
    const input: ContextSearchInput = {
      project,
      prompt: p.text,
      debug: true,
      bypassCache: true,
      noiseTolerance: isStrict ? 'strict' : 'balanced',
      contextMode: isLayered ? 'layered' : 'compact',
      deepContextBudget: isLayered ? 80_000 : undefined,
    };
    const pack = await service.searchContext(input);
    const doc = toReplay(pack);
    const out = join('src/workbench-v2/data/demo/replays', `${p.id}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(doc, null, 2));
  }
  console.log(`[demo-replays] wrote ${fixture.prompts.length} files`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
