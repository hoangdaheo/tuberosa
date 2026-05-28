import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeKnowledge, parseKnowledgeMarkdown, knowledgeFilename } from '../src/export/knowledge-codec.js';
import type { StoredKnowledge } from '../src/types.js';

const K: StoredKnowledge = {
  id: 'e5d4ffff-0000-0000-0000-000000000001',
  project: 'tuberosa',
  sourceType: 'manual',
  sourceUri: 'docs/pgvector.md',
  itemType: 'wiki',
  title: 'Pgvector tuning notes',
  summary: 'Notes',
  content: '# Pgvector tuning notes\n\nLong-form content body.',
  labels: [{ type: 'domain', value: 'retrieval', weight: 1 }],
  references: [{ type: 'file', uri: 'src/retrieval/policy.ts' }],
  trustLevel: 70,
  status: 'approved',
  metadata: {},
  createdAt: '2026-04-12T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

test('serializeKnowledge round-trips title/labels/refs and uses content as body', () => {
  const { content } = serializeKnowledge(K);
  const parsed = parseKnowledgeMarkdown(content);
  assert.equal(parsed.frontmatter.title, K.title);
  assert.deepEqual(parsed.frontmatter.labels, K.labels);
  assert.deepEqual(parsed.frontmatter.references, K.references);
  assert.equal(parsed.body.trim(), K.content.trim());
});

test('knowledgeFilename: slug + short id', () => {
  assert.match(knowledgeFilename(K), /^pgvector-tuning-notes-e5d4\.md$/);
});
