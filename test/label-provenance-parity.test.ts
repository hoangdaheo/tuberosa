import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import {
  LABEL_PROVENANCE_METADATA_KEY,
  mergeLabelProvenanceIntoMetadata,
} from '../src/storage/shared/label-provenance.js';
import type { KnowledgeInput, LabelInput } from '../src/types.js';

// Only labels that carry a `provenance` field produce a provenance entry.
// The stored key is `${type}:${normalizeLabel(value)}` and the value is the
// LabelProvenance object — see buildLabelProvenanceMap.
const labelWithProvenance: LabelInput = {
  type: 'symbol',
  value: 'updateKnowledge',
  weight: 0.85,
  provenance: { source: 'reviewer', confidence: 0.9 },
};

function baseInput(overrides: Partial<KnowledgeInput> = {}): KnowledgeInput {
  return {
    project: 'parity',
    sourceType: 'manual',
    sourceUri: 'manual://parity/label-provenance',
    itemType: 'code_ref',
    title: 'parity fixture',
    content: 'content',
    ...overrides,
  };
}

test('memory-store updateKnowledge writes label provenance into metadata (parity with postgres)', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.upsertKnowledge(baseInput(), []);

  const updated = await store.updateKnowledge(created.id, { labels: [labelWithProvenance] });
  assert.ok(updated, 'updateKnowledge should return the stored item');

  // Mirror exactly what the postgres updateKnowledge code path produces.
  const expected = mergeLabelProvenanceIntoMetadata(
    { ...created.metadata },
    [labelWithProvenance],
  )[LABEL_PROVENANCE_METADATA_KEY];

  assert.ok(
    LABEL_PROVENANCE_METADATA_KEY in updated.metadata,
    'metadata must contain the label-provenance key after updating labels',
  );
  assert.deepEqual(
    updated.metadata[LABEL_PROVENANCE_METADATA_KEY],
    expected,
    'provenance map must match the postgres code-path shape',
  );
  // Key shape sanity check: `${type}:${normalizeLabel(value)}`.
  assert.deepEqual(updated.metadata[LABEL_PROVENANCE_METADATA_KEY], {
    'symbol:updateknowledge': { source: 'reviewer', confidence: 0.9 },
  });
});

test('memory-store upsertKnowledge (create path) writes label provenance into metadata (parity with postgres)', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.upsertKnowledge(
    baseInput({ labels: [labelWithProvenance] }),
    [],
  );

  assert.ok(
    LABEL_PROVENANCE_METADATA_KEY in created.metadata,
    'create path must contain the label-provenance key when labels carry provenance',
  );
  assert.deepEqual(created.metadata[LABEL_PROVENANCE_METADATA_KEY], {
    'symbol:updateknowledge': { source: 'reviewer', confidence: 0.9 },
  });
});
