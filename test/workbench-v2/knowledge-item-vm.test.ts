import test from 'node:test';
import { equal } from 'node:assert/strict';
import { inferItemType } from '../../src/workbench-v2/viz/knowledge-item-vm.js';

test('inferItemType maps id prefixes', () => {
  equal(inferItemType('cr-paywall-001'), 'code_ref');
  equal(inferItemType('spec-subscription-tiers'), 'spec');
  equal(inferItemType('mem-migration-step-missed'), 'memory');
  equal(inferItemType('wiki-anything'), 'wiki');
  equal(inferItemType('unknown-id'), 'wiki');
});
