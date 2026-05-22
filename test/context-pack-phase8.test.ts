import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { assembleContextPack } from '../src/retrieval/context-pack.js';
import type {
  ClassifiedQuery,
  ContextFit,
  ContextPackActionItem,
  ContextReviewTarget,
  FitDiagnostics,
  RankedCandidate,
} from '../src/types.js';

// ────────────────────────────────────────────────────────────────────────
// Phase 8 — Brief groundedness + classification guard rails
//
// Pre-Phase-8 these tests are red:
//   - actionItems have no per-item evidenceIds field.
//   - read_file actions backed by no retrieved candidate are still emitted.
//   - inspect_review_target actions with zero token overlap are still emitted.
//
// Post-Phase-8:
//   - Every grounding-eligible action carries evidenceIds resolving to pack candidates.
//   - Ungrounded actions are dropped; a structured warning is appended to
//     fitDiagnostics.notes with a 'brief_warning:' prefix.
//   - Token-overlap check drops actions whose evidence has zero overlap with the
//     action's keywords.
// ────────────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  const knowledgeId = overrides.knowledgeId ?? 'k-default';
  const labels = overrides.labels ?? [];
  const references = overrides.references ?? [];
  return {
    knowledgeId,
    title: overrides.title ?? `Knowledge ${knowledgeId}`,
    summary: overrides.summary ?? 'summary',
    content: overrides.content ?? 'content',
    contextualContent: overrides.contextualContent ?? overrides.content ?? 'content',
    itemType: overrides.itemType ?? 'code_ref',
    project: overrides.project ?? 'phase8',
    labels,
    references,
    tokenEstimate: overrides.tokenEstimate ?? 200,
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

function makeClassified(overrides: Partial<ClassifiedQuery>): ClassifiedQuery {
  return {
    project: 'phase8',
    taskType: overrides.taskType ?? 'implementation',
    confidence: overrides.confidence ?? 0.85,
    files: overrides.files ?? [],
    symbols: overrides.symbols ?? [],
    errors: overrides.errors ?? [],
    technologies: overrides.technologies ?? [],
    businessAreas: overrides.businessAreas ?? [],
    exactTerms: overrides.exactTerms ?? [],
    lexicalQuery: overrides.lexicalQuery ?? 'phase8 query',
    intent: {
      taskGoal: 'implement phase 8',
      workflowStage: 'implementation',
      taskBriefMode: overrides.intent?.taskBriefMode ?? 'implementation',
      impliedFiles: overrides.intent?.impliedFiles ?? [],
      impliedSymbols: overrides.intent?.impliedSymbols ?? [],
      impliedDomains: overrides.intent?.impliedDomains ?? [],
      objectHints: overrides.intent?.objectHints ?? [],
      recentSessionReferences: overrides.intent?.recentSessionReferences ?? [],
      requiredEvidenceTypes: overrides.intent?.requiredEvidenceTypes ?? [],
      uncertaintyReasons: overrides.intent?.uncertaintyReasons ?? [],
    },
  };
}

function makeContextFit(notes: string[] = []): ContextFit {
  const diagnostics: FitDiagnostics = {
    contributors: { top1: 0.8, top3Avg: 0.7, coverage: 0.9, worktreeMatchScore: 0 },
    weights: { top1: 0.55, top3Avg: 0.2, coverage: 0.15, worktreeMatch: 0.1 },
    thresholds: { ready: 0.72, needsConfirmation: 0.45 },
    rerankerAvailable: true,
    notes: [...notes],
  };
  return {
    fitStatus: 'ready',
    fitScore: 0.78,
    fitReasons: ['top candidate'],
    missingSignals: [],
    fitDiagnostics: diagnostics,
  };
}

function actionsOf(pack: { taskBrief?: { actionItems: ContextPackActionItem[] } }): ContextPackActionItem[] {
  return pack.taskBrief?.actionItems ?? [];
}

function findReadFile(items: ContextPackActionItem[], path: string): ContextPackActionItem | undefined {
  return items.find((item) => item.action === 'read_file' && item.targetPath === path);
}

function findInspect(items: ContextPackActionItem[], title: string): ContextPackActionItem | undefined {
  return items.find((item) => item.action === 'inspect_review_target' && item.targetTitle === title);
}

function diagnosticsNotes(pack: { contextFit?: ContextFit }): string[] {
  return pack.contextFit?.fitDiagnostics?.notes ?? [];
}

test('Phase 8: read_file action backed by a candidate is kept and carries evidenceIds', async () => {
  const knowledgeId = '11111111-1111-1111-1111-111111111111';
  const candidate = makeCandidate({
    knowledgeId,
    title: 'Email queue handler at src/email/queue.ts',
    content: 'export function sendQueuedEmail() { /* ... */ }',
    labels: [
      { type: 'file', value: 'src/email/queue.ts' },
      { type: 'symbol', value: 'sendQueuedEmail' },
    ],
    references: [{ type: 'file', uri: 'src/email/queue.ts' }],
    matchReasons: ['file:src/email/queue.ts', 'symbol:sendQueuedEmail'],
  });
  const classified = makeClassified({
    files: ['src/email/queue.ts'],
    symbols: ['sendQueuedEmail'],
  });

  const pack = assembleContextPack({
    prompt: 'Fix the email queue handler in src/email/queue.ts',
    classified,
    candidates: [candidate],
    tokenBudget: 4000,
    contextFit: makeContextFit(),
  });

  const items = actionsOf(pack);
  const readAction = findReadFile(items, 'src/email/queue.ts');
  ok(readAction, 'read_file action for src/email/queue.ts should be kept');
  deepEqual(readAction!.evidenceIds, [knowledgeId], 'evidenceIds should point to the matching candidate');
  const notes = diagnosticsNotes(pack);
  ok(!notes.some((note) => note.startsWith('brief_warning:')), 'no brief_warning should be emitted for grounded actions');
});

test('Phase 8: read_file action with no candidate evidence is dropped and warning is emitted', async () => {
  const unrelated = makeCandidate({
    knowledgeId: '22222222-2222-2222-2222-222222222222',
    title: 'Article search handler at src/retrieval/search.ts',
    labels: [{ type: 'file', value: 'src/retrieval/search.ts' }],
    references: [{ type: 'file', uri: 'src/retrieval/search.ts' }],
    matchReasons: ['file:src/retrieval/search.ts'],
  });
  // User mentions a file that NO retrieved candidate references.
  const classified = makeClassified({
    files: ['src/retrieval/search.ts', 'src/widgets/legacy-banner.tsx'],
  });

  const pack = assembleContextPack({
    prompt: 'Review src/widgets/legacy-banner.tsx alongside the search handler',
    classified,
    candidates: [unrelated],
    tokenBudget: 4000,
    contextFit: makeContextFit(),
  });

  const items = actionsOf(pack);
  equal(findReadFile(items, 'src/widgets/legacy-banner.tsx'), undefined, 'ungrounded read_file should be dropped');
  ok(findReadFile(items, 'src/retrieval/search.ts'), 'grounded read_file should survive');

  const notes = diagnosticsNotes(pack);
  ok(
    notes.some((note) => note.startsWith('brief_warning:dropped_ungrounded_action:') && note.includes('src/widgets/legacy-banner.tsx')),
    `expected brief_warning for src/widgets/legacy-banner.tsx, got ${JSON.stringify(notes)}`,
  );
});

test('Phase 8: inspect_review_target action whose candidate has zero token overlap is dropped', async () => {
  const reviewTargetId = '33333333-3333-3333-3333-333333333333';
  // Candidate with knowledgeId === reviewTargetId, but its searchable text shares ZERO
  // tokens with the review target's title.
  const candidate = makeCandidate({
    knowledgeId: reviewTargetId,
    title: 'aaaaa',
    summary: 'bbbbb',
    content: 'ccccc ddddd eeeee',
    contextualContent: 'ccccc ddddd eeeee',
    labels: [],
    references: [],
    matchReasons: ['lexical match'],
  });
  const reviewTargets: ContextReviewTarget[] = [
    {
      kind: 'reflection_draft',
      id: reviewTargetId,
      status: 'pending',
      title: 'Refactor article archive sender queue',
      recommendedAction: 'inspect',
      reason: 'Pending review',
    },
  ];

  const pack = assembleContextPack({
    prompt: 'Inspect pending refactor proposals',
    classified: makeClassified({
      taskType: 'review',
      intent: { taskBriefMode: 'reflection_review' } as ClassifiedQuery['intent'],
    }),
    candidates: [candidate],
    tokenBudget: 4000,
    contextFit: makeContextFit(),
    reviewTargets,
  });

  const items = actionsOf(pack);
  equal(
    findInspect(items, 'Refactor article archive sender queue'),
    undefined,
    'inspect_review_target with zero-overlap evidence should be dropped',
  );
  const notes = diagnosticsNotes(pack);
  ok(
    notes.some(
      (note) =>
        note.startsWith('brief_warning:dropped_zero_overlap_action:')
        && note.includes('Refactor article archive sender queue'),
    ),
    `expected zero-overlap warning, got ${JSON.stringify(notes)}`,
  );
});

test('Phase 8: review_target evidence and policy-only actions are preserved when grounded', async () => {
  const targetId = '44444444-4444-4444-4444-444444444444';
  const candidate = makeCandidate({
    knowledgeId: targetId,
    title: 'Refactor article archive queue dispatcher',
    summary: 'Dispatcher rewrite proposal.',
    content: 'Refactor queue dispatcher with new archive semantics for article moderation.',
    contextualContent: 'Refactor queue dispatcher with new archive semantics for article moderation.',
    labels: [
      { type: 'symbol', value: 'ArticleArchiveDispatcher' },
      { type: 'business_area', value: 'content' },
    ],
    references: [],
    matchReasons: ['lexical match'],
  });
  const reviewTargets: ContextReviewTarget[] = [
    {
      kind: 'reflection_draft',
      id: targetId,
      status: 'pending',
      title: 'Refactor article archive queue dispatcher',
      recommendedAction: 'inspect',
      reason: 'Pending review',
    },
  ];

  const pack = assembleContextPack({
    prompt: 'Inspect pending refactor proposals',
    classified: makeClassified({
      taskType: 'review',
      businessAreas: ['content'],
      intent: { taskBriefMode: 'reflection_review' } as ClassifiedQuery['intent'],
    }),
    candidates: [candidate],
    tokenBudget: 4000,
    contextFit: makeContextFit(),
    reviewTargets,
  });

  const items = actionsOf(pack);
  const inspect = findInspect(items, 'Refactor article archive queue dispatcher');
  ok(inspect, 'inspect_review_target with token-overlap evidence should survive');
  deepEqual(inspect!.evidenceIds, [targetId], 'evidenceIds on a review-target action should reference the target id');

  // Policy-only actions (run_verification / ask_clarification / inspect_shortlist) should
  // not be subject to the guard — they're system recommendations, not knowledge-grounded.
  const verification = items.find((item) => item.action === 'run_verification');
  if (verification) {
    ok(
      verification.evidenceIds === undefined || verification.evidenceIds.length === 0,
      'run_verification actions should not carry per-candidate evidence',
    );
  }

  const notes = diagnosticsNotes(pack);
  ok(!notes.some((note) => note.startsWith('brief_warning:')), 'no brief_warning should be emitted on a fully grounded pack');
});
