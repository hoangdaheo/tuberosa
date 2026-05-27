import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { KNOWLEDGE_COLORS, ITEM_TYPES, colorFor, labelFor } from '../../src/workbench-v2/viz/knowledge-colors.js';

test('every known item type has a hex and label', () => {
  deepEqual(ITEM_TYPES, ['code_ref', 'spec', 'memory', 'wiki']);
  for (const t of ITEM_TYPES) {
    equal(KNOWLEDGE_COLORS[t].hex.startsWith('#'), true);
    equal(typeof KNOWLEDGE_COLORS[t].label, 'string');
  }
});

test('colorFor/labelFor fall back to wiki for unknown types', () => {
  equal(colorFor('code_ref'), '#d4a574');
  equal(labelFor('spec'), 'spec');
  equal(colorFor('totally-unknown'), KNOWLEDGE_COLORS.wiki.hex);
  equal(labelFor('totally-unknown'), 'wiki');
});
