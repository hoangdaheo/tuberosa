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
    prompt: 'Review the auth flow. Then inspect the Investigate helper.',
    cwd: '/home/nash/tuberosa',
  });

  ok(
    classified.symbols.includes('Investigate'),
    'verb-like symbol names outside the first sentence should still classify as symbols',
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
