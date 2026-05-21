import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inferItemType } from '../src/ingest/item-type-inference.js';

test('error-recovery trigger maps to bugfix', () => {
  const result = inferItemType({
    content: 'Some incident note',
    metadata: { triggerType: 'error_recovery' },
    references: [],
  });
  assert.equal(result.itemType, 'bugfix');
  assert.ok(result.confidence > 0.8);
});

test('error_log origin maps to bugfix even without trigger', () => {
  const result = inferItemType({
    content: 'log analysis',
    metadata: { source: 'error_log' },
    references: [],
  });
  assert.equal(result.itemType, 'bugfix');
});

test('test references with root-cause language map to bugfix, otherwise workflow', () => {
  const bugfix = inferItemType({
    content: 'root cause was a missing await on the transaction commit',
    references: [{ type: 'file', uri: 'test/auth.test.ts' }],
  });
  assert.equal(bugfix.itemType, 'bugfix');

  const workflow = inferItemType({
    content: 'How to run the integration suite for the auth flow without docker.',
    references: [{ type: 'file', uri: 'test/auth.test.ts' }],
  });
  assert.equal(workflow.itemType, 'workflow');
});

test('rule heading or normative MUST/SHALL maps to rule', () => {
  const heading = inferItemType({
    content: '## Rule: always sanitize user input before storage',
    references: [],
  });
  assert.equal(heading.itemType, 'rule');

  const must = inferItemType({
    content: 'Every retrieval response MUST include a context-fit status.',
    references: [],
  });
  assert.equal(must.itemType, 'rule');
});

test('workflow heading maps to workflow', () => {
  const result = inferItemType({
    content: '## Runbook: restart the Postgres pod and verify migrations',
    references: [],
  });
  assert.equal(result.itemType, 'workflow');
});

test('spec heading or specs/* reference maps to spec', () => {
  const heading = inferItemType({
    content: '# Specification\n## API contract',
    references: [],
  });
  assert.equal(heading.itemType, 'spec');

  const refs = inferItemType({
    content: 'Body of a design doc',
    references: [{ type: 'file', uri: 'specs/retrieval.md' }],
  });
  assert.equal(refs.itemType, 'spec');
});

test('high code-fence ratio + code references map to code_ref', () => {
  const content = [
    'Here is the relevant snippet:',
    '```ts',
    'function add(a: number, b: number): number { return a + b; }',
    'export function inc(value: number) { return add(value, 1); }',
    'const sum = inc(1);',
    '```',
    'It composes the previous helper.',
  ].join('\n');
  const result = inferItemType({
    content,
    references: [{ type: 'file', uri: 'src/util/math.ts' }],
  });
  assert.equal(result.itemType, 'code_ref');
});

test('conversation heading maps to conversation', () => {
  const result = inferItemType({
    content: '## Conversation\nUser asked about retries.',
    references: [],
  });
  assert.equal(result.itemType, 'conversation');
});

test('non-memory hint is honoured as a soft fallback when no rule fires', () => {
  const result = inferItemType({
    content: 'Just plain prose with no markers',
    references: [],
    hint: 'wiki',
  });
  assert.equal(result.itemType, 'wiki');
});

test('falls back to memory as the catch-all when no signal fires', () => {
  const result = inferItemType({
    content: 'just a sentence',
    references: [],
  });
  assert.equal(result.itemType, 'memory');
  assert.ok(result.reasons.some((reason) => reason.includes('memory')));
});
