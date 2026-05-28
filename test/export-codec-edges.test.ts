import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeEdges, parseEdgesJsonl } from '../src/export/edges-codec.js';
import type { BundleEdge } from '../src/types.js';

const edges: BundleEdge[] = [
  { from: 'aaaa', to: 'bbbb', kind: 'refines', confidence: 0.85, inferenceSource: 'semantic' },
  { from: 'cccc', to: 'dddd', kind: 'co_changes_with', confidence: 0.62, inferenceSource: 'co_change' },
];

test('serializeEdges sorts deterministically by (from, to, kind)', () => {
  const shuffled = [...edges].reverse();
  const out = serializeEdges(shuffled);
  const lines = out.trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].from, 'aaaa');
});

test('parseEdgesJsonl round-trips', () => {
  const out = serializeEdges(edges);
  const parsed = parseEdgesJsonl(out);
  assert.deepEqual(parsed, edges);
});
