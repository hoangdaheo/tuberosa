import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isPersistedKnowledgeId } from '../src/util/uuid.js';

test('isPersistedKnowledgeId: accepts canonical and version-agnostic uuids', () => {
  assert.equal(isPersistedKnowledgeId('5f50a373-6fdd-46a1-83a5-7fb80c97de19'), true);
  assert.equal(isPersistedKnowledgeId('00000000-0000-0000-0000-000000000000'), true);
});

test('isPersistedKnowledgeId: rejects non-uuid ids', () => {
  assert.equal(isPersistedKnowledgeId('worktree:abc123'), false);
  assert.equal(isPersistedKnowledgeId('not-a-uuid'), false);
  assert.equal(isPersistedKnowledgeId(''), false);
  assert.equal(isPersistedKnowledgeId(undefined), false);
  assert.equal(isPersistedKnowledgeId(42), false);
});
