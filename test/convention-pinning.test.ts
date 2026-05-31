import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { assembleContextPack } from '../src/retrieval/context-pack.js';
import type { ClassifiedQuery, RankedCandidate } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 3 — Convention pinning
//
// Convention candidates (source === 'convention') must be pinned to the FRONT
// of the essential section regardless of their finalScore/rank. In particular:
//
//   1. When normal candidates have directTaskEvidence and convention has a lower
//      evidenceCategory, convention must still appear BEFORE them in essential.
//   2. A convention candidate must not be displaced from essential by other items
//      even when the normal 4-item essential cap is already filled.
//   3. Multiple convention candidates all pin together, ahead of everything else.
//   4. When no convention candidates exist the pack is completely unaffected.
// ────────────────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  const knowledgeId = overrides.knowledgeId ?? 'k-default';
  return {
    knowledgeId,
    title: overrides.title ?? `Knowledge ${knowledgeId}`,
    summary: overrides.summary ?? 'summary',
    content: overrides.content ?? 'content',
    contextualContent: overrides.contextualContent ?? overrides.content ?? 'content',
    itemType: overrides.itemType ?? 'code_ref',
    project: overrides.project ?? 'test-project',
    labels: overrides.labels ?? [],
    references: overrides.references ?? [],
    tokenEstimate: overrides.tokenEstimate ?? 100,
    trustLevel: overrides.trustLevel ?? 85,
    source: overrides.source ?? 'lexical',
    rawScore: overrides.rawScore ?? 0.9,
    rank: overrides.rank ?? 1,
    fusedScore: overrides.fusedScore ?? 0.9,
    rerankScore: overrides.rerankScore ?? 0.9,
    finalScore: overrides.finalScore ?? 0.9,
    matchReasons: overrides.matchReasons ?? ['lexical match'],
    fitScore: overrides.fitScore ?? 0.85,
    fitReasons: overrides.fitReasons ?? [],
    fitMissingSignals: overrides.fitMissingSignals ?? [],
    metadata: overrides.metadata,
    freshnessAt: overrides.freshnessAt,
  };
}

function makeClassified(overrides: Partial<ClassifiedQuery> = {}): ClassifiedQuery {
  return {
    project: 'test-project',
    taskType: overrides.taskType ?? 'implementation',
    confidence: overrides.confidence ?? 0.85,
    // Include a named file so normal candidates qualify as directTaskEvidence
    // (higher priority than workflowGuidance, so without explicit pinning they'd rank first).
    files: overrides.files ?? ['src/auth.ts'],
    symbols: overrides.symbols ?? [],
    errors: overrides.errors ?? [],
    technologies: overrides.technologies ?? [],
    businessAreas: overrides.businessAreas ?? [],
    exactTerms: overrides.exactTerms ?? [],
    lexicalQuery: overrides.lexicalQuery ?? 'test query',
    intent: {
      taskGoal: 'implement feature',
      workflowStage: 'implementation',
      taskBriefMode: 'implementation',
      impliedFiles: [],
      impliedSymbols: [],
      impliedDomains: [],
      objectHints: [],
      recentSessionReferences: [],
      requiredEvidenceTypes: [],
      uncertaintyReasons: [],
    },
  };
}

/** Build a normal lexical candidate with a file-match so it gets directTaskEvidence priority. */
function makeDirectEvidence(id: string, rank: number, score: number): RankedCandidate {
  return makeCandidate({
    knowledgeId: id,
    source: 'lexical',
    finalScore: score,
    fusedScore: score,
    rawScore: score,
    rank,
    matchReasons: ['file:src/auth.ts', 'lexical match'],
    labels: [{ type: 'file', value: 'src/auth.ts' }],
  });
}

/** Build a convention candidate with a lower score than the directEvidence ones. */
function makeConvention(id: string, rank: number): RankedCandidate {
  return makeCandidate({
    knowledgeId: id,
    title: `Convention: ${id}`,
    source: 'convention',
    finalScore: 0.50,
    fusedScore: 0.50,
    rawScore: 0.50,
    rank,
    itemType: 'wiki',
    matchReasons: ['convention match'],
  });
}

function essentialItems(pack: ReturnType<typeof assembleContextPack>): RankedCandidate[] {
  return pack.sections.find((s) => s.name === 'essential')?.items ?? [];
}

// ─── Test 1: convention appears first even when competing against directTaskEvidence ───

test('convention candidate is pinned to front of essential even when others have directTaskEvidence', () => {
  // Three direct-evidence candidates (priority 1 in sort) that would normally own essential.
  const highA = makeDirectEvidence('high-a', 1, 0.95);
  const highB = makeDirectEvidence('high-b', 2, 0.90);
  const highC = makeDirectEvidence('high-c', 3, 0.88);
  // Convention candidate: lower score, would naturally lose to directTaskEvidence (priority 3 vs 1).
  const convention = makeConvention('conv-1', 4);

  const pack = assembleContextPack({
    prompt: 'implement auth feature',
    classified: makeClassified(),
    candidates: [highA, highB, highC, convention],
    tokenBudget: 10_000,
  });

  const essential = essentialItems(pack);
  ok(essential.length > 0, 'essential section should not be empty');
  equal(
    essential[0].knowledgeId,
    'conv-1',
    `expected convention candidate first in essential; got ${essential[0].knowledgeId} (evidenceCategory=${essential[0].evidenceCategory})`,
  );
});

// ─── Test 2: convention must appear in essential even when the 4-item cap is already filled ───

test('convention candidate is in essential even when 4 directTaskEvidence candidates would fill the cap', () => {
  // Four direct-evidence candidates to fill the normal 4-item essential cap.
  const highA = makeDirectEvidence('high-a', 1, 0.97);
  const highB = makeDirectEvidence('high-b', 2, 0.93);
  const highC = makeDirectEvidence('high-c', 3, 0.90);
  const highD = makeDirectEvidence('high-d', 4, 0.87);
  const convention = makeConvention('conv-1', 5);

  const pack = assembleContextPack({
    prompt: 'implement auth feature',
    classified: makeClassified(),
    candidates: [highA, highB, highC, highD, convention],
    tokenBudget: 10_000,
  });

  const essential = essentialItems(pack);
  const hasConvention = essential.some((item) => item.knowledgeId === 'conv-1');
  ok(hasConvention, `convention candidate must appear in essential even with 4 competing items; got ${essential.map((i) => i.knowledgeId).join(', ')}`);
  equal(essential[0].knowledgeId, 'conv-1', `convention must be first in essential`);
});

// ─── Test 3: multiple conventions all pin to front ───

test('multiple convention candidates all pin to front of essential before any normal item', () => {
  const conv1 = makeConvention('conv-alpha', 3);
  const conv2 = makeConvention('conv-beta', 4);
  const normal1 = makeDirectEvidence('normal-1', 1, 0.99);
  const normal2 = makeDirectEvidence('normal-2', 2, 0.95);

  const pack = assembleContextPack({
    prompt: 'implement auth feature',
    classified: makeClassified(),
    candidates: [normal1, normal2, conv1, conv2],
    tokenBudget: 10_000,
  });

  const essential = essentialItems(pack);
  ok(essential.length >= 2, 'essential section should have at least 2 items');

  const convIndices = essential
    .map((item, index) => ({ knowledgeId: item.knowledgeId, source: item.source, index }))
    .filter((entry) => entry.source === 'convention')
    .map((entry) => entry.index);

  const firstNormalIndex = essential.findIndex((item) => item.source !== 'convention');

  ok(convIndices.length === 2, `expected 2 convention items in essential, got ${convIndices.length}`);
  ok(
    firstNormalIndex === -1 || convIndices.every((ci) => ci < firstNormalIndex),
    `all convention items must precede any normal item; essential=${essential.map((i) => `${i.knowledgeId}(${i.source})`).join(', ')}`,
  );
});

// ─── Test 4: no convention candidates — pack unaffected ───

test('pack with no convention candidates is unaffected by convention pinning logic', () => {
  const candidates = [
    makeDirectEvidence('a', 1, 0.95),
    makeDirectEvidence('b', 2, 0.80),
    makeDirectEvidence('c', 3, 0.70),
  ];

  const pack = assembleContextPack({
    prompt: 'implement auth feature',
    classified: makeClassified(),
    candidates,
    tokenBudget: 10_000,
  });

  const essential = essentialItems(pack);
  ok(essential.length > 0, 'essential section should not be empty');
  const hasConvention = essential.some((item) => item.source === 'convention');
  equal(hasConvention, false, 'no convention item should appear when none were provided');
  // The first essential item should be the top-ranked direct-evidence candidate.
  equal(essential[0].knowledgeId, 'a', `expected top direct-evidence candidate first; got ${essential[0].knowledgeId}`);
});
