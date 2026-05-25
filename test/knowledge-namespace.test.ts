import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import {
  deriveNamespace,
  kindFromItemType,
  namespaceMatchesFilter,
  readNamespaceFromMetadata,
  writeNamespaceToMetadata,
} from '../src/storage/knowledge-namespace.js';

test('kindFromItemType collapses memory/bugfix/rule into reflection', () => {
  equal(kindFromItemType('memory'), 'reflection');
  equal(kindFromItemType('bugfix'), 'reflection');
  equal(kindFromItemType('rule'), 'reflection');
});

test('kindFromItemType keeps wiki/spec/code_ref/workflow/conversation independent', () => {
  equal(kindFromItemType('wiki'), 'wiki');
  equal(kindFromItemType('spec'), 'spec');
  equal(kindFromItemType('code_ref'), 'code_ref');
  equal(kindFromItemType('workflow'), 'workflow');
  equal(kindFromItemType('conversation'), 'conversation');
});

test('deriveNamespace prefers an explicit namespace when both project and kind are set', () => {
  const ns = deriveNamespace({
    project: 'derived-project',
    itemType: 'wiki',
    namespace: { project: 'explicit', kind: 'spec', agent: 'mother' },
  });
  deepEqual(ns, { project: 'explicit', kind: 'spec', agent: 'mother' });
});

test('deriveNamespace falls back to project + kindFromItemType when no explicit namespace', () => {
  const ns = deriveNamespace({ project: 'tuberosa', itemType: 'memory' });
  deepEqual(ns, { project: 'tuberosa', kind: 'reflection' });
});

test('deriveNamespace pulls agent from metadata.agentName when present', () => {
  const ns = deriveNamespace({
    project: 'tuberosa',
    itemType: 'memory',
    metadata: { agentName: 'mother-judge' },
  });
  deepEqual(ns, { project: 'tuberosa', kind: 'reflection', agent: 'mother-judge' });
});

test('deriveNamespace falls back to metadata.agentTool when agentName missing', () => {
  const ns = deriveNamespace({
    project: 'tuberosa',
    itemType: 'memory',
    metadata: { agentTool: 'debater' },
  });
  deepEqual(ns, { project: 'tuberosa', kind: 'reflection', agent: 'debater' });
});

test('deriveNamespace ignores blank agent metadata', () => {
  const ns = deriveNamespace({
    project: 'tuberosa',
    itemType: 'memory',
    metadata: { agentName: '   ' },
  });
  deepEqual(ns, { project: 'tuberosa', kind: 'reflection' });
});

test('readNamespaceFromMetadata returns undefined when metadata.namespace is missing or malformed', () => {
  equal(readNamespaceFromMetadata(undefined), undefined);
  equal(readNamespaceFromMetadata({}), undefined);
  equal(readNamespaceFromMetadata({ namespace: 'not-an-object' }), undefined);
  equal(readNamespaceFromMetadata({ namespace: null }), undefined);
  equal(readNamespaceFromMetadata({ namespace: { project: 'p' /* no kind */ } }), undefined);
  equal(readNamespaceFromMetadata({ namespace: { kind: 'wiki' /* no project */ } }), undefined);
});

test('readNamespaceFromMetadata roundtrips through writeNamespaceToMetadata', () => {
  const written = writeNamespaceToMetadata({ extra: 'keep' }, { project: 'p', kind: 'wiki', agent: 'a' });
  equal((written as { extra: string }).extra, 'keep');
  deepEqual(readNamespaceFromMetadata(written), { project: 'p', kind: 'wiki', agent: 'a' });
});

test('writeNamespaceToMetadata omits the agent field when absent', () => {
  const written = writeNamespaceToMetadata(undefined, { project: 'p', kind: 'wiki' });
  deepEqual((written as { namespace: object }).namespace, { project: 'p', kind: 'wiki' });
});

test('namespaceMatchesFilter: undefined filter is a no-op (backwards compatibility)', () => {
  equal(namespaceMatchesFilter(undefined, undefined), true);
  equal(namespaceMatchesFilter({ project: 'p', kind: 'k' }, undefined), true);
  equal(namespaceMatchesFilter({ project: 'p', kind: 'k' }, {}), true);
});

test('namespaceMatchesFilter: filter without stored namespace fails closed', () => {
  equal(namespaceMatchesFilter(undefined, { project: 'p' }), false);
});

test('namespaceMatchesFilter: matches each field independently', () => {
  const stored = { project: 'tuberosa', kind: 'wiki', agent: 'mother' };
  equal(namespaceMatchesFilter(stored, { project: 'tuberosa' }), true);
  equal(namespaceMatchesFilter(stored, { project: 'other' }), false);
  equal(namespaceMatchesFilter(stored, { kind: 'wiki' }), true);
  equal(namespaceMatchesFilter(stored, { kind: 'spec' }), false);
  equal(namespaceMatchesFilter(stored, { agent: 'mother' }), true);
  equal(namespaceMatchesFilter(stored, { agent: 'debater' }), false);
});
