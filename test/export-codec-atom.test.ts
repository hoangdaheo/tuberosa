import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeAtom, parseAtomMarkdown, atomFilename } from '../src/export/atom-codec.js';
import type { KnowledgeAtom } from '../src/types/atoms.js';

const A: KnowledgeAtom = {
  id: 'bf3a2b1f-4c2d-4a0e-9111-000000000001',
  project: 'tuberosa',
  claim: 'pgvector column dim must equal EMBEDDING_DIMENSIONS in config.',
  type: 'gotcha',
  evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
  trigger: { errors: ['vector dimension mismatch'], symbols: ['EMBEDDING_DIMENSIONS'] },
  verification: { command: 'pnpm run eval:retrieval' },
  pitfalls: ["Don't lower --fail-under-hit-rate to mask failures"],
  links: [{ toAtomId: '2a91-aaaa-bbbb-cccc-dddddddddddd', kind: 'refines', confidence: 0.85 }],
  tier: 'canonical',
  reuseCount: 4,
  lastReusedAt: '2026-05-12T00:00:00.000Z',
  status: 'active',
  audit: {
    producedBy: 'agent_session',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
  },
  scope: 'project',
};

test('serializeAtom + parseAtomMarkdown: round-trip preserves all fields', () => {
  const { content } = serializeAtom(A, { revision: 3 });
  const parsed = parseAtomMarkdown(content);
  assert.equal(parsed.frontmatter.id, A.id);
  assert.equal(parsed.frontmatter.revision, 3);
  assert.equal(parsed.frontmatter.tier, A.tier);
  assert.deepEqual(parsed.frontmatter.trigger, A.trigger);
  assert.deepEqual(parsed.frontmatter.evidence, A.evidence);
  assert.equal(parsed.body.trim(), A.claim);
});

test('parseAtomMarkdown: body is the claim when frontmatter.claim is absent', () => {
  const md = `---
id: x
revision: 1
project: p
type: fact
tier: draft
status: active
trigger: { errors: ["e"] }
evidence: [{ kind: file, path: a.ts }]
audit: { producedBy: agent_session, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" }
---

This is the claim sentence.
`;
  const parsed = parseAtomMarkdown(md);
  assert.equal(parsed.body.trim(), 'This is the claim sentence.');
  assert.equal(parsed.frontmatter.claim, undefined);
});

test('parseAtomMarkdown: frontmatter.claim overrides body when both present', () => {
  const md = `---
id: x
revision: 1
project: p
type: fact
tier: draft
status: active
trigger: { errors: ["e"] }
evidence: [{ kind: file, path: a.ts }]
claim: "Explicit claim wins."
audit: { producedBy: agent_session, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" }
---

Ignored body.
`;
  const parsed = parseAtomMarkdown(md);
  assert.equal(parsed.frontmatter.claim, 'Explicit claim wins.');
});

test('atomFilename: stable slug-and-id pattern', () => {
  const f = atomFilename(A);
  assert.match(f, /^pgvector-column-dim-must-equal-embedding-dimensions-bf3a\.md$/);
});

test('parseAtomMarkdown: throws with file location on bad YAML', () => {
  const md = `---
id: x
tier: "unterminated
---
body`;
  assert.throws(() => parseAtomMarkdown(md, { filename: 'atoms/bad.md' }), /atoms\/bad\.md/);
});
