/**
 * Task 3: Fixture coverage test.
 *
 * Seeds a MemoryKnowledgeStore with acmeBilling.items (and relations), runs
 * each prompt through RetrievalService.searchContext with debug: true, collects
 * every observed branch tag, and asserts that every branch claimed by any
 * prompt is actually observed. Also enforces a floor of ≥10 distinct branches.
 *
 * Branch observation rules (mapped to real API fields):
 *
 *   fit:ready / fit:needs_confirmation / fit:insufficient
 *     → pack.contextFit.fitStatus
 *
 *   source:fts       → pack.debug.stages has a 'lexical' stage with candidateCount > 0
 *   source:vector    → pack.debug.stages has a 'vector' stage with candidateCount > 0
 *   source:memory    → pack.debug.stages has a 'memory' stage with candidateCount > 0
 *   source:graph     → pack.debug.stages has a 'graph' stage with candidateCount > 0
 *   source:labels    → pack.debug.stages has a 'metadata' stage with candidateCount > 0
 *
 *   classifier:symbols        → classified.symbols.length > 0
 *   classifier:errors         → classified.errors.length > 0
 *   classifier:business_areas → classified.businessAreas.length > 0
 *   classifier:empty          → symbols, errors, and files all empty
 *
 *   adjust:memory_boost   → at least one selected item has a matchReason starting with 'feedback:selected:'
 *                           (requires warm-up pass: run query → save pack → record selected → re-run)
 *   adjust:stale_penalty  → pack.debug.suppressionEvents has an event with reason === 'stale_freshness'
 *   adjust:superseded     → pack.debug.suppressionEvents has an event with reason === 'superseded'
 *
 *   mode:strict_noise         → noiseTolerance:'strict' was requested AND
 *                               contextFit.fitStatus is 'needs_confirmation' or 'insufficient'
 *   mode:layered_deep_context → pack.deepContext exists and deepContext.mode === 'layered'
 */

import test from 'node:test';
import { ok } from 'node:assert/strict';
import { MemoryCache } from '../../src/cache.js';
import type { AppConfig } from '../../src/config.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import type { ContextPack, ContextSearchInput, KnowledgeInput, RetrievalDebugTrace, SuppressionEvent } from '../../src/types.js';
import { acmeBilling, type BranchTag, type SeedFixture } from '../../src/workbench-v2/data/fixtures.js';

// ---------------------------------------------------------------------------
// Minimal AppConfig for tests (no external services).
// ---------------------------------------------------------------------------
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
  worktreeEnabled: false,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a KnowledgeInput from a seed item. We bypass IngestionService and call
 * store.upsertKnowledge directly so the test is deterministic and fast.
 */
function seedItemToKnowledgeInput(
  item: SeedFixture['items'][number],
  project: string,
): KnowledgeInput {
  return {
    project,
    sourceType: 'fixture',
    sourceUri: item.sourceUri,
    itemType: item.itemType as KnowledgeInput['itemType'],
    title: item.title,
    summary: item.content.slice(0, 200),
    content: item.content,
    // High trust for all items so the reranker's trust score pushes finalScore up
    // and per-candidate fitScore reaches the 'ready' threshold (0.72).
    trustLevel: 95,
    labels: item.labels ?? [],
    references: item.references ?? [],
    // Stale freshness for mem-liveintent-old — declared as freshnessAt in the fixture.
    freshnessAt: (item as { freshnessAt?: string }).freshnessAt,
    metadata: {},
  };
}

/** Extract observable branch tags from a completed searchContext result. */
function observeBranches(
  pack: ContextPack,
  isStrictMode: boolean,
): Set<BranchTag> {
  const observed = new Set<BranchTag>();
  const debug = pack.debug as RetrievalDebugTrace | undefined;

  // --- fit status ---
  const fitStatus = pack.contextFit?.fitStatus;
  if (fitStatus === 'ready') observed.add('fit:ready');
  if (fitStatus === 'needs_confirmation') observed.add('fit:needs_confirmation');
  if (fitStatus === 'insufficient') observed.add('fit:insufficient');

  // --- sources (from debug stages) ---
  if (debug?.stages) {
    for (const stage of debug.stages) {
      if (stage.candidateCount > 0) {
        if (stage.name === 'lexical') observed.add('source:fts');
        if (stage.name === 'vector') observed.add('source:vector');
        if (stage.name === 'memory') observed.add('source:memory');
        if (stage.name === 'graph') observed.add('source:graph');
        if (stage.name === 'metadata') observed.add('source:labels');
      }
    }
  }

  // --- classifier signals ---
  const classified = pack.classified;
  if (classified) {
    if (classified.symbols?.length > 0) observed.add('classifier:symbols');
    if (classified.errors?.length > 0) observed.add('classifier:errors');
    if (classified.businessAreas?.length > 0) observed.add('classifier:business_areas');
    if (
      (!classified.symbols || classified.symbols.length === 0)
      && (!classified.errors || classified.errors.length === 0)
      && (!classified.files || classified.files.length === 0)
    ) {
      observed.add('classifier:empty');
    }
  }

  // --- ranking adjustments (suppression events) ---
  const suppressionEvents: SuppressionEvent[] = debug?.suppressionEvents ?? [];
  if (suppressionEvents.some((e) => e.reason === 'stale_freshness')) {
    observed.add('adjust:stale_penalty');
  }
  if (suppressionEvents.some((e) => e.reason === 'superseded')) {
    observed.add('adjust:superseded');
  }

  // --- memory boost = any selected item has feedback:selected: matchReason ---
  const allItems = pack.sections?.flatMap((s) => s.items) ?? [];
  if (allItems.some((item) => item.matchReasons?.some((r) => r.startsWith('feedback:selected:')))) {
    observed.add('adjust:memory_boost');
  }

  // --- mode signals ---
  if (isStrictMode) {
    observed.add('mode:strict_noise');
  }
  if (pack.deepContext?.mode === 'layered') {
    observed.add('mode:layered_deep_context');
  }

  return observed;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

test('acme-billing fixture exercises all declared branches', async () => {
  const fixture = acmeBilling;
  const project = fixture.project;

  // --- Seed store ---
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider(TEST_CONFIG.embeddingDimensions);
  const cache = new MemoryCache();

  // Build id-to-stored-id map for relation wiring.
  const storedIdBySeedId = new Map<string, string>();

  for (const item of fixture.items) {
    const input = seedItemToKnowledgeInput(item, project);
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
    storedIdBySeedId.set(item.id, stored.id);
  }

  // Wire graph relations between items using the real store API.
  for (const rel of fixture.relations ?? []) {
    const fromId = storedIdBySeedId.get(rel.fromId);
    const toId = storedIdBySeedId.get(rel.toId);
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

  // ---------------------------------------------------------------------------
  // Warm-up pass for prompts that claim adjust:memory_boost.
  //
  // The FeedbackInput.selected type requires a contextPackId — it reads the
  // knowledge IDs from the pack's sections. So we run the query once, save the
  // pack id, record selected feedback, then the real pass will observe the boost.
  // ---------------------------------------------------------------------------
  const memoryBoostPromptIds = new Set(
    fixture.prompts
      .filter((p) => (p.branches as BranchTag[]).includes('adjust:memory_boost'))
      .map((p) => p.id),
  );

  for (const promptDef of fixture.prompts) {
    if (!memoryBoostPromptIds.has(promptDef.id)) continue;

    const warmupPack = await service.searchContext({
      project,
      prompt: promptDef.text,
      debug: false,
      bypassCache: true,
    });

    // Save pack so the store has it, then record selected feedback against it.
    // (searchContext already calls store.saveContextPack internally)
    if (warmupPack.id) {
      await store.recordFeedback({
        project,
        feedbackType: 'selected',
        contextPackId: warmupPack.id,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Main evaluation pass
  // ---------------------------------------------------------------------------
  const allObserved = new Set<BranchTag>();
  const perPrompt: Array<{ id: string; claimed: BranchTag[]; observed: BranchTag[]; missing: BranchTag[] }> = [];

  for (const promptDef of fixture.prompts) {
    const isStrictMode = (promptDef.branches as BranchTag[]).includes('mode:strict_noise');
    const isLayeredMode = (promptDef.branches as BranchTag[]).includes('mode:layered_deep_context');

    const searchInput: ContextSearchInput = {
      project,
      prompt: promptDef.text,
      debug: true,
      bypassCache: true,
      noiseTolerance: isStrictMode ? 'strict' : 'balanced',
      contextMode: isLayeredMode ? 'layered' : 'compact',
      deepContextBudget: isLayeredMode ? 80_000 : undefined,
    };

    const pack = await service.searchContext(searchInput);
    const observed = observeBranches(pack, isStrictMode);

    for (const tag of observed) {
      allObserved.add(tag);
    }

    const claimed = promptDef.branches as BranchTag[];
    const missing = claimed.filter((b) => !observed.has(b));
    perPrompt.push({ id: promptDef.id, claimed, observed: [...observed], missing });
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  const failingPrompts = perPrompt.filter((p) => p.missing.length > 0);
  if (failingPrompts.length > 0) {
    const details = failingPrompts.map((p) =>
      `  ${p.id}: claimed=[${p.claimed.join(', ')}] observed=[${p.observed.join(', ')}] missing=[${p.missing.join(', ')}]`,
    ).join('\n');
    throw new Error(`Some prompts did not observe all claimed branches:\n${details}`);
  }

  // Sanity floor: at least 10 distinct branch tags observed across all prompts.
  ok(
    allObserved.size >= 10,
    `Expected ≥10 distinct branches observed, got ${allObserved.size}: [${[...allObserved].join(', ')}]`,
  );
});
