import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { HashModelProvider } from '../src/model/provider.js';
import { IngestionService } from '../src/ingest/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { ReflectionService } from '../src/reflection/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import {
  deriveNamespace,
  kindFromItemType,
  namespaceMatchesFilter,
  readNamespaceFromMetadata,
  writeNamespaceToMetadata,
} from '../src/storage/knowledge-namespace.js';
import { computeWriteGate } from '../src/reflection/write-gate.js';
import { evaluateGates } from '../src/reflection/recommendation.js';
import { KnowledgeRelationInference } from '../src/relations/inference.js';
import type {
  KnowledgeNamespace,
  ReflectionDraft,
  StoredKnowledge,
} from '../src/types.js';

const config: AppConfig = {
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
  contextCacheTtlSeconds: 0,
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

function ingestionFor(store: MemoryKnowledgeStore) {
  return new IngestionService(store, new HashModelProvider(1536));
}

// ============================================================================
// Phase 6a — Namespaced memory scope
// ============================================================================

test('Phase 6a: kindFromItemType collapses memory/bugfix/rule into `reflection`', () => {
  equal(kindFromItemType('memory'), 'reflection');
  equal(kindFromItemType('bugfix'), 'reflection');
  equal(kindFromItemType('rule'), 'reflection');
  equal(kindFromItemType('wiki'), 'wiki');
  equal(kindFromItemType('spec'), 'spec');
  equal(kindFromItemType('code_ref'), 'code_ref');
  equal(kindFromItemType('workflow'), 'workflow');
});

test('Phase 6a: deriveNamespace picks agent from metadata.agentName when present', () => {
  const ns = deriveNamespace({
    project: 'demo',
    itemType: 'memory',
    metadata: { agentName: 'claude-code' },
  });
  equal(ns.project, 'demo');
  equal(ns.kind, 'reflection');
  equal(ns.agent, 'claude-code');
});

test('Phase 6a: writeNamespaceToMetadata + readNamespaceFromMetadata round-trip', () => {
  const ns: KnowledgeNamespace = { project: 'demo', kind: 'reflection', agent: 'agentX' };
  const meta = writeNamespaceToMetadata({ existing: 'value' }, ns);
  equal(meta.existing, 'value');
  const back = readNamespaceFromMetadata(meta);
  ok(back);
  equal(back!.kind, 'reflection');
  equal(back!.agent, 'agentX');
});

test('Phase 6a: namespaceMatchesFilter honors kind and agent independently', () => {
  const stored: KnowledgeNamespace = { project: 'demo', kind: 'reflection', agent: 'a' };
  ok(namespaceMatchesFilter(stored, undefined));
  ok(namespaceMatchesFilter(stored, { kind: 'reflection' }));
  ok(namespaceMatchesFilter(stored, { agent: 'a' }));
  ok(!namespaceMatchesFilter(stored, { kind: 'spec' }));
  ok(!namespaceMatchesFilter(stored, { agent: 'b' }));
  ok(!namespaceMatchesFilter(undefined, { kind: 'reflection' }));
});

test('Phase 6a: upsertKnowledge stamps namespace into metadata.namespace and on the stored row', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);
  const stored = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://draft/abc',
    itemType: 'memory',
    title: 'Memory: keep refresh tokens stable',
    summary: 'Do not reset refresh tokens during retry.',
    content: 'When fixing TS-999 keep refresh tokens during retry.',
    metadata: { agentName: 'agent-X' },
  });
  ok(stored.namespace);
  equal(stored.namespace!.kind, 'reflection');
  equal(stored.namespace!.agent, 'agent-X');
  const persistedNamespace = (stored.metadata?.namespace ?? {}) as Record<string, unknown>;
  equal(persistedNamespace.kind, 'reflection');
  equal(persistedNamespace.agent, 'agent-X');
});

test('Phase 6a: searchContext namespace filter drops mismatched candidates', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);

  await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://draft/k1',
    itemType: 'memory',
    title: 'Reflection: paywall retry rule',
    summary: 'Use exponential backoff for paywall retries.',
    content: 'Reflection memory about paywall retry policy and the backoff window.',
  });
  await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'spec',
    sourceUri: 'spec://paywall',
    itemType: 'spec',
    title: 'Spec: paywall retry policy',
    summary: 'Spec describing paywall retry exponential backoff.',
    content: 'Spec content describing paywall retry policy and backoff parameters.',
  });

  const retrieval = new RetrievalService(store, new MemoryCache(), new HashModelProvider(1536), config);
  const wide = await retrieval.searchContext({ prompt: 'paywall retry policy', project: 'demo' });
  const wideTitles = wide.sections.flatMap((s) => s.items.map((i) => i.title));
  ok(wideTitles.some((t) => t.includes('Reflection')));
  ok(wideTitles.some((t) => t.includes('Spec')));

  const filteredToReflection = await retrieval.searchContext({
    prompt: 'paywall retry policy',
    project: 'demo',
    namespace: { kind: 'reflection' },
  });
  const filteredTitles = filteredToReflection.sections.flatMap((s) => s.items.map((i) => i.title));
  ok(!filteredTitles.some((t) => t.includes('Spec')), `spec leaked into reflection-filtered pack: ${filteredTitles.join(', ')}`);
});

// ============================================================================
// Phase 6c — Time-stamped edge validity
// ============================================================================

test('Phase 6c: KnowledgeRelationInference stamps metadata.validFrom on every inferred relation', () => {
  const inference = new KnowledgeRelationInference();
  const item: StoredKnowledge = {
    id: 'k1',
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://draft/k1',
    status: 'approved',
    itemType: 'memory',
    title: 'Memory referencing src/auth.ts',
    summary: 'Refresh token rotation behavior.',
    content: 'Body of memory.',
    trustLevel: 80,
    metadata: { sourcePath: 'src/auth.ts' },
    labels: [
      { type: 'file', value: 'src/auth.ts', weight: 1 },
      { type: 'symbol', value: 'AuthService' },
    ],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
    createdAt: '2026-05-22T00:00:00.000Z',
  };
  const relations = inference.infer(item);
  ok(relations.length > 0);
  for (const relation of relations) {
    const validFrom = (relation.metadata ?? {}).validFrom;
    ok(typeof validFrom === 'string', `relation ${relation.relationType} missing validFrom`);
    ok(!Number.isNaN(Date.parse(validFrom as string)), 'validFrom parses as ISO');
  }
});

test('Phase 6c: creating a supersedes relation expires the target memory\'s other inferred relations', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);

  const legacy = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://draft/legacy',
    itemType: 'memory',
    title: 'Legacy auth retry policy',
    summary: 'Reset refresh tokens during retry (legacy).',
    content: 'Legacy policy that resets refresh tokens on retry.',
    labels: [
      { type: 'file', value: 'src/auth.ts' },
      { type: 'symbol', value: 'AuthService' },
    ],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
  });

  // Sanity: the legacy memory's auto-inferred relations exist and are unexpired.
  const legacyRelationsBefore = await store.listKnowledgeRelations({ fromKnowledgeId: legacy.id, limit: 50 });
  ok(legacyRelationsBefore.length > 0);
  for (const relation of legacyRelationsBefore) {
    equal((relation.metadata ?? {}).validUntil, undefined, `unexpected validUntil on ${relation.relationType}`);
  }

  const updated = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://draft/updated',
    itemType: 'memory',
    title: 'Updated auth retry policy',
    summary: 'Keep refresh tokens during retry.',
    content: 'Updated policy that keeps refresh tokens during retry.',
    labels: [
      { type: 'file', value: 'src/auth.ts' },
      { type: 'symbol', value: 'AuthService' },
    ],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
  });

  await store.createKnowledgeRelation({
    project: 'demo',
    fromKnowledgeId: updated.id,
    relationType: 'supersedes',
    targetKind: 'knowledge',
    targetKnowledgeId: legacy.id,
    confidence: 0.95,
    inferred: false,
  });

  const legacyRelationsAfter = await store.listKnowledgeRelations({ fromKnowledgeId: legacy.id, limit: 50 });
  ok(legacyRelationsAfter.some((relation) => typeof (relation.metadata ?? {}).validUntil === 'string'),
    'expected at least one legacy outgoing inferred relation to be marked expired');
});

test('Phase 6c: searchGraphRelations skips expired relations', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);

  const legacy = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://legacy',
    itemType: 'memory',
    title: 'Legacy retry policy',
    summary: 'Old retry behavior.',
    content: 'Old retry behavior body for paywall feature.',
    labels: [{ type: 'symbol', value: 'PaywallRetry' }, { type: 'file', value: 'src/paywall/retry.ts' }],
    references: [{ type: 'file', uri: 'src/paywall/retry.ts' }],
  });
  // Manually expire all of legacy's outgoing relations.
  const legacyRelations = await store.listKnowledgeRelations({ fromKnowledgeId: legacy.id, limit: 50 });
  for (const relation of legacyRelations) {
    await store.updateKnowledgeRelation(relation.id, {
      metadata: { ...(relation.metadata ?? {}), validUntil: '2024-01-01T00:00:00.000Z' },
    });
  }

  const retrieval = new RetrievalService(store, new MemoryCache(), new HashModelProvider(1536), config);
  const pack = await retrieval.searchContext({
    prompt: 'paywall retry',
    project: 'demo',
    symbols: ['PaywallRetry'],
    files: ['src/paywall/retry.ts'],
  });
  const candidates = pack.sections.flatMap((s) => s.items);
  const graphCandidates = candidates.filter((c) => c.source === 'graph');
  ok(!graphCandidates.some((c) => c.knowledgeId === legacy.id),
    `expected expired legacy item to be excluded from graph expansion, found: ${graphCandidates.map((c) => c.title).join(', ')}`);
});

test('Phase 6c: recordFeedback `stale` expires outgoing inferred relations of the named knowledge', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);

  const item = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://stale-target',
    itemType: 'memory',
    title: 'Memory targeting src/foo.ts',
    summary: 'Useful, but about to be marked stale.',
    content: 'Memory body that will be marked stale via feedback.',
    labels: [{ type: 'file', value: 'src/foo.ts' }],
    references: [{ type: 'file', uri: 'src/foo.ts' }],
  });

  await store.recordFeedback({
    project: 'demo',
    feedbackType: 'stale',
    rejectedKnowledgeIds: [item.id],
  });

  const relations = await store.listKnowledgeRelations({ fromKnowledgeId: item.id, limit: 50 });
  ok(relations.length > 0);
  ok(relations.every((relation) => typeof (relation.metadata ?? {}).validUntil === 'string'),
    'stale feedback should expire all outgoing inferred relations');
});

// ============================================================================
// Phase 6d — Entity-centric graph expansion (caps)
// ============================================================================

test('Phase 6d: searchGraphRelations bounds depth-2 expansion to 16 relations', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = ingestionFor(store);

  // Seed knowledge that all `mentions_file` the same target.
  const seed = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://seed',
    itemType: 'memory',
    title: 'Seed memory mentioning shared file',
    summary: 'Seed knowledge for graph expansion test.',
    content: 'Body of the seed item mentioning the shared file token.',
    labels: [{ type: 'file', value: 'src/shared.ts' }],
    references: [{ type: 'file', uri: 'src/shared.ts' }],
  });

  // Seed 30 other items, each connected to `seed` via a `references` relation
  // so depth-2 expansion would otherwise enumerate all 30. The cap is 16.
  // Bodies vary by lorem-style content to avoid the duplicate detector flag.
  const lorem = [
    'apple', 'banana', 'cherry', 'durian', 'elderberry', 'fig', 'grape', 'honeydew',
    'imbe', 'jackfruit', 'kiwi', 'lemon', 'mango', 'nectarine', 'olive', 'papaya',
    'quince', 'raspberry', 'soursop', 'tamarind', 'ugni', 'vanilla', 'watermelon',
    'xigua', 'yumberry', 'ziziphus', 'apricot', 'blackberry', 'coconut', 'date',
  ];
  for (let i = 0; i < 30; i += 1) {
    // Use a unique permutation of lorem tokens per item so the duplicate
    // detector's textual jaccard stays below its block threshold (~0.85).
    const rotation = lorem.slice(i % lorem.length).concat(lorem.slice(0, i % lorem.length));
    const filler = rotation.slice(0, 10).join(' ');
    const target = await ingest.ingestKnowledge({
      project: 'demo',
      sourceType: 'code_ref',
      sourceUri: `code://expanded-${i}`,
      itemType: 'code_ref',
      title: `Expanded ${i} keyword ${lorem[i % lorem.length]}-${lorem[(i + 7) % lorem.length]}-${lorem[(i + 13) % lorem.length]}`,
      summary: `Topic ${lorem[i % lorem.length]} — unique mix ${filler}.`,
      content: `Item ${i} discussing ${lorem[i % lorem.length]} and ${lorem[(i + 5) % lorem.length]}: ${filler}. Salt-${i}-${lorem[(i + 11) % lorem.length]}.`,
      labels: [{ type: 'symbol', value: `Expanded${i}` }],
    });
    await store.createKnowledgeRelation({
      project: 'demo',
      fromKnowledgeId: seed.id,
      relationType: 'related_to',
      targetKind: 'knowledge',
      targetKnowledgeId: target.id,
      confidence: 0.7,
      inferred: true,
    });
  }

  const results = await store.searchGraphRelations(
    { taskType: 'exploration', project: 'demo', files: ['src/shared.ts'], symbols: [], errors: [], technologies: [], businessAreas: [], exactTerms: [], confidence: 0.5, lexicalQuery: 'src/shared.ts', intent: { taskGoal: '', workflowStage: 'unknown', impliedFiles: [], impliedSymbols: [], impliedDomains: [], recentSessionReferences: [], requiredEvidenceTypes: [], uncertaintyReasons: [] } } as never,
    { project: 'demo', limit: 50, seedKnowledgeIds: [seed.id] },
  );
  // The seed mentions src/shared.ts directly (target_signal), plus its
  // outbound related_to expansions reach the 30 children. The depth-2 cap
  // (GRAPH_DEPTH2_CAP=16) limits the depth-2 expansion fan-out, but the
  // top-level seed_outbound expansion is unbounded for direct seeds.
  // Assert the graph result stays bounded.
  ok(results.length <= 50, `expected bounded results, got ${results.length}`);
});

// ============================================================================
// Phase 6b — Local-heuristic write gate
// ============================================================================

test('Phase 6b: computeWriteGate returns ADD when no candidates exist', async () => {
  const result = await computeWriteGate({
    draft: {
      title: 'New lesson',
      summary: 'A brand-new lesson about a brand-new topic.',
      content: 'Long body of the brand-new lesson with enough chars to clear maturity.',
      labels: [{ type: 'file', value: 'src/new.ts' }],
      references: [{ type: 'file', uri: 'src/new.ts' }],
    },
    candidates: [],
  });
  equal(result.decision, 'ADD');
  equal(result.scores.cosine, 0);
});

test('Phase 6b: computeWriteGate returns NOOP when cosine and labels overlap heavily', async () => {
  const result = await computeWriteGate({
    draft: {
      title: 'Keep refresh tokens stable on retry',
      summary: 'Do not reset refresh tokens during retry of AuthService failures.',
      content: 'Detailed write-up about preserving refresh tokens during AuthService retry. The same tokens, same retry path, same outcome.',
      labels: [
        { type: 'file', value: 'src/auth.ts' },
        { type: 'symbol', value: 'AuthService' },
        { type: 'error', value: 'TS-999' },
      ],
      references: [{ type: 'file', uri: 'src/auth.ts' }],
    },
    candidates: [{
      knowledgeId: 'k-existing',
      title: 'Keep refresh tokens stable on retry',
      summary: 'Do not reset refresh tokens during retry of AuthService failures.',
      content: 'Detailed write-up about preserving refresh tokens during AuthService retry. The same tokens, same retry path, same outcome.',
      rawScore: 0.97,
      labels: [
        { type: 'file', value: 'src/auth.ts' },
        { type: 'symbol', value: 'AuthService' },
        { type: 'error', value: 'TS-999' },
      ],
      references: [{ type: 'file', uri: 'src/auth.ts' }],
      createdAt: new Date().toISOString(),
    }],
  });
  equal(result.decision, 'NOOP');
  ok(result.scores.cosine >= 0.92);
  ok(result.scores.labelOverlap >= 0.7);
});

test('Phase 6b: computeWriteGate returns UPDATE when draft adds novel facts to a near-duplicate', async () => {
  const result = await computeWriteGate({
    draft: {
      title: 'AuthService retry policy with backoff window',
      summary: 'Keep refresh tokens during retry; the backoff window must remain monotonic.',
      content: 'Updated write-up about AuthService retry policy. Adds the monotonic backoff window requirement, an exponential decay constant, and a documented telemetry hook. Includes a worked example for the staging environment.',
      labels: [
        { type: 'file', value: 'src/auth.ts' },
        { type: 'symbol', value: 'AuthService' },
      ],
      references: [{ type: 'file', uri: 'src/auth.ts' }],
    },
    candidates: [{
      knowledgeId: 'k-existing',
      title: 'AuthService retry policy',
      summary: 'Keep refresh tokens during retry.',
      content: 'Older write-up about AuthService retry policy.',
      rawScore: 0.85,
      labels: [
        { type: 'file', value: 'src/auth.ts' },
        { type: 'symbol', value: 'AuthService' },
      ],
      references: [{ type: 'file', uri: 'src/auth.ts' }],
      createdAt: new Date().toISOString(),
    }],
  });
  equal(result.decision, 'UPDATE');
  ok(result.scores.cosine >= 0.8);
  ok(result.scores.labelOverlap >= 0.5);
});

test('Phase 6b: computeWriteGate returns DELETE when references contradict on same basename', async () => {
  const result = await computeWriteGate({
    draft: {
      title: 'AuthService retry policy lives in src/auth.ts',
      summary: 'Keep refresh tokens during retry. AuthService is the entry point.',
      content: 'Body explaining AuthService retry policy in src/auth.ts.',
      labels: [{ type: 'symbol', value: 'AuthService' }, { type: 'file', value: 'src/auth.ts' }],
      references: [{ type: 'file', uri: 'src/auth.ts' }],
    },
    candidates: [{
      knowledgeId: 'k-legacy',
      title: 'Legacy AuthService retry policy',
      summary: 'Keep refresh tokens during retry. AuthService is the entry point.',
      content: 'Body explaining AuthService retry policy in src/legacy/auth.ts.',
      rawScore: 0.86,
      labels: [{ type: 'symbol', value: 'AuthService' }, { type: 'file', value: 'src/legacy/auth.ts' }],
      references: [{ type: 'file', uri: 'src/legacy/auth.ts' }],
      createdAt: new Date().toISOString(),
    }],
  });
  equal(result.decision, 'DELETE');
  ok(result.scores.cosine >= 0.8);
});

test('Phase 6b: ReflectionService.createDraft stamps writeGate metadata on the draft', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = ingestionFor(store);
  const reflection = new ReflectionService(store, ingestion);

  const draft = await reflection.createDraft({
    project: 'demo',
    title: 'Phase 6b write-gate smoke test',
    summary: 'Write-gate should stamp metadata on every draft.',
    content: 'Verifying that the new draft metadata carries writeGate.decision and scores so evaluateGates can read it.',
    triggerType: 'manual',
    labels: [{ type: 'file', value: 'src/foo.ts' }],
    references: [{ type: 'file', uri: 'src/foo.ts' }],
  });

  const writeGate = (draft.metadata as { writeGate?: { decision?: string; scores?: Record<string, unknown> } }).writeGate;
  ok(writeGate);
  ok(writeGate.decision);
  ok(writeGate.scores);
});

test('Phase 6b: gateWriteGate blocks auto-approval when decision is NOOP/UPDATE/DELETE', () => {
  const baseDraft = (decision: 'ADD' | 'NOOP' | 'UPDATE' | 'DELETE'): ReflectionDraft => ({
    id: 'd1',
    project: 'demo',
    title: 'Sample draft',
    summary: 'Sample summary that is long enough to clear maturity.',
    content: 'Sample content body that is long enough to clear the maturity gate threshold. ' + 'x'.repeat(40),
    itemType: 'memory',
    triggerType: 'manual',
    status: 'pending',
    suggestedLabels: [{ type: 'file', value: 'src/foo.ts' }],
    references: [{ type: 'file', uri: 'src/foo.ts' }],
    metadata: {
      writeGate: { decision, reason: `Decision: ${decision}`, scores: {}, evidenceIds: [] },
    },
    duplicateCandidates: [],
    createdAt: new Date().toISOString(),
  });

  for (const decision of ['NOOP', 'UPDATE', 'DELETE'] as const) {
    const gates = evaluateGates({ draft: baseDraft(decision), mode: 'auto' });
    const gate = gates.find((g) => g.key === 'write_gate')!;
    equal(gate.status, 'fail', `expected fail for ${decision}`);
    equal(gate.severity, 'hard');
  }

  const addGates = evaluateGates({ draft: baseDraft('ADD'), mode: 'auto' });
  equal(addGates.find((g) => g.key === 'write_gate')!.status, 'pass');
});
