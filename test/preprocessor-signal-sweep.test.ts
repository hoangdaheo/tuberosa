import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sweepSignals } from '../src/retrieval/signal-sweep.js';

test('sweepSignals: extracts file paths from prose and code blocks', () => {
  const prompt = 'Refactor src/retrieval/fusion.ts and also fix src/retrieval/policy.ts.\n```\n// see src/retrieval/policy.ts\n```';
  const out = sweepSignals(prompt);
  const paths = out.files.map((f) => f.value).sort();
  assert.deepEqual(paths, ['src/retrieval/fusion.ts', 'src/retrieval/policy.ts']);
});

test('sweepSignals: capitalized-camel symbols are extracted; common words are not', () => {
  // Wrap symbols in backticks so they earn a code_block anchor — single bare
  // prose mentions are intentionally treated as noise (see capAndDrop docs).
  const prompt = 'The `PaywallSelectionModal` calls `fuseCandidates` after `RankCandidates` returns.';
  const symbols = sweepSignals(prompt).symbols.map((s) => s.value);
  assert.ok(symbols.includes('PaywallSelectionModal'));
  assert.ok(symbols.includes('fuseCandidates'));
  assert.ok(!symbols.includes('The'));
});

test('sweepSignals: applies code_block bonus and frequency saturation', () => {
  const prompt = '```\nupdate src/x.ts\n```\nThen update src/x.ts again. Then update src/x.ts again.';
  const file = sweepSignals(prompt).files.find((f) => f.value === 'src/x.ts');
  assert.ok(file);
  assert.ok(file!.reasons.includes('code_block'));
  assert.ok(file!.reasons.includes('frequency'));
  assert.ok(file!.reasons.includes('imperative_proximity'));
});

test('sweepSignals: caps files to 10 even when 50 distinct paths appear', () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    lines.push(`update src/file_${i}.ts`);
  }
  const out = sweepSignals(lines.join('\n'));
  assert.equal(out.files.length, 10);
});

test('sweepSignals: drops signals below minScore (single unprefixed mention)', () => {
  const prompt = 'There is a thing called fooBar somewhere in passing context here.';
  const symbols = sweepSignals(prompt).symbols;
  assert.equal(symbols.length, 0);
});
