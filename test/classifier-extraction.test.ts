import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { classifyQuery, labelsFromClassification } from '../src/retrieval/classifier.js';

test('classifier does not surface task-action verbs as symbols', () => {
  const cases: { prompt: string; bannedSymbol: string }[] = [
    { prompt: 'Investigate the auth flow and trace why login fails.', bannedSymbol: 'Investigate' },
    { prompt: 'Audit the retrieval pipeline for stale graph relations.', bannedSymbol: 'Audit' },
    { prompt: 'Map the call graph between fusion and rerank.', bannedSymbol: 'Map' },
    { prompt: 'Plan the migration off the legacy reranker.', bannedSymbol: 'Plan' },
    { prompt: 'Analyze the fusion weights and propose a calibration.', bannedSymbol: 'Analyze' },
    { prompt: 'Expand the symbol stop list with task verbs.', bannedSymbol: 'Expand' },
    { prompt: 'Answer how the rerank fallback path triggers.', bannedSymbol: 'Answer' },
  ];

  for (const { prompt, bannedSymbol } of cases) {
    const classified = classifyQuery({ prompt, cwd: '/home/nash/tuberosa' });
    equal(
      classified.symbols.includes(bannedSymbol),
      false,
      `classifier should not extract "${bannedSymbol}" as a symbol (prompt="${prompt}")`,
    );
  }
});

test('user-supplied symbols via the symbols: input bypass stopwording', () => {
  const classified = classifyQuery({
    prompt: 'Refactor the Investigate helper to reuse the shared reporter.',
    symbols: ['Investigate'],
    cwd: '/home/nash/tuberosa',
  });

  ok(
    classified.symbols.includes('Investigate'),
    'symbols passed via input must survive the stopword filter (caller authority wins)',
  );
});

test('classifier prompt-verb stopwording only applies to the first sentence', () => {
  const classified = classifyQuery({
    prompt: 'Review the auth flow. Then inspect the `Investigate` helper.',
    cwd: '/home/nash/tuberosa',
  });

  ok(
    classified.symbols.includes('Investigate'),
    'back-ticked verb-like symbol names outside the first sentence should still classify as symbols',
  );
  equal(classified.symbols.includes('Review'), false);
});

test('classifier emits domain as first-class label when files imply a src/X/ domain', () => {
  const classified = classifyQuery({
    prompt: 'Tighten the dedup logic in src/retrieval/fusion.ts.',
    cwd: '/home/nash/tuberosa',
  });

  equal(classified.domain, 'retrieval');

  const labels = labelsFromClassification(classified);
  const domainLabel = labels.find((label) => label.type === 'domain');
  ok(domainLabel, 'labelsFromClassification must emit a domain label when classified.domain is set');
  equal(domainLabel?.value, 'retrieval');
  equal(domainLabel?.provenance?.source, 'classifier');
  ok(
    (domainLabel?.provenance?.confidence ?? 0) >= 0.6,
    'inferred domain label should carry classifier-source confidence',
  );
});

test('classifier-emitted labels all carry classifier provenance', () => {
  const classified = classifyQuery({
    prompt: 'Refactor fusion in src/retrieval/fusion.ts around fuseCandidates.',
    cwd: '/home/nash/tuberosa',
  });

  const labels = labelsFromClassification(classified);
  ok(labels.length > 0, 'classifier should emit at least one label for this prompt');

  for (const label of labels) {
    ok(
      label.provenance,
      `every classifier-emitted label must carry provenance (offending label: ${label.type}=${label.value})`,
    );
    equal(label.provenance?.source, 'classifier');
    ok(
      (label.provenance?.confidence ?? 0) > 0,
      `provenance.confidence must be > 0 for ${label.type}=${label.value}`,
    );
  }
});

test('classifier emits no domain label when no src/X/ file is present', () => {
  const classified = classifyQuery({
    prompt: 'How does the rerank fallback path work?',
    cwd: '/home/nash/tuberosa',
  });

  const labels = labelsFromClassification(classified);
  equal(labels.find((label) => label.type === 'domain'), undefined);
});

// Label-pruning pass: the extractor used to emit ALL-CAPS prose, prose words
// that merely precede a parenthetical, and back-ticked common English words as
// `symbol:` labels. Those junk symbols become noisy reflection-memory labels and
// dilute label-based recall. Each banned word below was observed leaking from a
// real session prompt; each kept identifier must still survive (no false negatives).

test('classifier does not surface ALL-CAPS prose words as symbols', () => {
  const cases: { prompt: string; banned: string[] }[] = [
    {
      prompt: 'Real-world runs must NEVER silently serve fake hash search. Use REAL models or fail loud.',
      banned: ['NEVER', 'REAL'],
    },
    {
      prompt: 'Drive the smoke eval RED then GREEN under TDD discipline.',
      banned: ['RED', 'GREEN', 'TDD'],
    },
  ];

  for (const { prompt, banned } of cases) {
    const classified = classifyQuery({ prompt, cwd: '/home/nash/tuberosa' });
    for (const word of banned) {
      equal(
        classified.symbols.includes(word),
        false,
        `ALL-CAPS prose word "${word}" must not be a symbol (prompt="${prompt}")`,
      );
    }
  }
});

test('classifier does not surface prose words that merely precede a parenthetical as symbols', () => {
  const classified = classifyQuery({
    prompt:
      'The test ran (twice) and the assertion failed (once); is the value true (proves it)? Found a bug (in rerank).',
    cwd: '/home/nash/tuberosa',
  });

  for (const word of ['ran', 'failed', 'true', 'bug']) {
    equal(
      classified.symbols.includes(word),
      false,
      `prose word "${word}" before a parenthetical must not be a symbol`,
    );
  }
});

test('classifier does not surface back-ticked common English words as symbols', () => {
  const classified = classifyQuery({
    prompt: 'The `ran` flag, a `bug`, the `assertion`, `true`, and `unavailable` all leaked into labels.',
    cwd: '/home/nash/tuberosa',
  });

  for (const word of ['ran', 'bug', 'assertion', 'true', 'unavailable']) {
    equal(
      classified.symbols.includes(word),
      false,
      `back-ticked English word "${word}" must not be a symbol`,
    );
  }
});

test('classifier still extracts real code identifiers (no false negatives from pruning)', () => {
  const classified = classifyQuery({
    prompt:
      'Refactor `TransformersScorer` and `hasLocalReranker` in the `RerankPipeline`; load `bge-reranker-v2-m3-ONNX`, read `snake_case` and `dotted.path`.',
    cwd: '/home/nash/tuberosa',
  });

  for (const symbol of [
    'TransformersScorer',
    'hasLocalReranker',
    'RerankPipeline',
    'bge-reranker-v2-m3-ONNX',
    'snake_case',
    'dotted.path',
  ]) {
    ok(
      classified.symbols.includes(symbol),
      `real identifier "${symbol}" must still be extracted as a symbol`,
    );
  }
});

test('classifier still extracts genuine function-call identifiers', () => {
  const classified = classifyQuery({
    prompt: 'Call searchContext() then hasLocalReranker() to verify the path.',
    cwd: '/home/nash/tuberosa',
  });

  ok(classified.symbols.includes('searchContext'), 'searchContext() should classify as a symbol');
  ok(classified.symbols.includes('hasLocalReranker'), 'hasLocalReranker() should classify as a symbol');
});
