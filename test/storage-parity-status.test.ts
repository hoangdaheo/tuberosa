import test from 'node:test';
import { ok } from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ClassifiedQuery, SearchOptions } from '../src/types.js';

const PROJECT = 'parity-status';

const baseClassified: ClassifiedQuery = {
  taskType: 'exploration',
  confidence: 0.9,
  lexicalQuery: 'parity status doc',
  files: [],
  symbols: [],
  errors: [],
  technologies: [],
  businessAreas: [],
  exactTerms: [],
  intent: {
    taskGoal: 'parity status doc',
    workflowStage: 'discovery',
    impliedFiles: [],
    impliedSymbols: [],
    impliedDomains: [],
    recentSessionReferences: [],
    requiredEvidenceTypes: [],
    uncertaintyReasons: [],
  },
};

const baseOptions: SearchOptions = {
  project: PROJECT,
  limit: 10,
};

async function seedTwo(store: MemoryKnowledgeStore) {
  const approved = await store.upsertKnowledge(
    {
      project: PROJECT,
      sourceType: 'file',
      sourceUri: 'docs/approved.md',
      itemType: 'wiki',
      title: 'parity status doc approved',
      summary: 'approved entry',
      content: 'parity status doc approved body',
      labels: [],
      references: [],
    },
    [{ content: 'parity status doc approved body', contextualContent: 'parity status doc approved body', tokenEstimate: 8, embedding: new Array(1536).fill(0.001) }],
  );
  const pending = await store.upsertKnowledge(
    {
      project: PROJECT,
      sourceType: 'file',
      sourceUri: 'docs/pending.md',
      itemType: 'wiki',
      title: 'parity status doc pending',
      summary: 'pending entry',
      content: 'parity status doc pending body',
      labels: [],
      references: [],
    },
    [{ content: 'parity status doc pending body', contextualContent: 'parity status doc pending body', tokenEstimate: 8, embedding: new Array(1536).fill(0.001) }],
  );
  await store.updateKnowledge(pending.id, { status: 'pending' });
  return { approvedId: approved.id, pendingId: pending.id };
}

test('memory-store searchLexical excludes non-approved items', async () => {
  const store = new MemoryKnowledgeStore();
  const { approvedId, pendingId } = await seedTwo(store);
  const candidates = await store.searchLexical(baseClassified, baseOptions);
  const ids = new Set(candidates.map((c) => c.knowledgeId));
  ok(ids.has(approvedId), 'approved item is returned');
  ok(!ids.has(pendingId), 'pending item must be excluded');
});

test('memory-store searchVector excludes non-approved items', async () => {
  const store = new MemoryKnowledgeStore();
  const { approvedId, pendingId } = await seedTwo(store);
  const candidates = await store.searchVector(new Array(1536).fill(0.001), baseOptions);
  const ids = new Set(candidates.map((c) => c.knowledgeId));
  ok(ids.has(approvedId), 'approved item is returned');
  ok(!ids.has(pendingId), 'pending item must be excluded');
});

test('memory-store searchMemories excludes non-approved items', async () => {
  const store = new MemoryKnowledgeStore();
  // memory-typed items
  const approved = await store.upsertKnowledge(
    {
      project: PROJECT,
      sourceType: 'file',
      sourceUri: 'docs/approved-rule.md',
      itemType: 'rule',
      title: 'parity rule approved',
      summary: 'approved rule',
      content: 'parity rule approved body',
      labels: [],
      references: [],
    },
    [{ content: 'parity rule approved body', contextualContent: 'parity rule approved body', tokenEstimate: 8, embedding: new Array(1536).fill(0.001) }],
  );
  const pending = await store.upsertKnowledge(
    {
      project: PROJECT,
      sourceType: 'file',
      sourceUri: 'docs/pending-rule.md',
      itemType: 'rule',
      title: 'parity rule pending',
      summary: 'pending rule',
      content: 'parity rule pending body',
      labels: [],
      references: [],
    },
    [{ content: 'parity rule pending body', contextualContent: 'parity rule pending body', tokenEstimate: 8, embedding: new Array(1536).fill(0.001) }],
  );
  await store.updateKnowledge(pending.id, { status: 'pending' });

  const candidates = await store.searchMemories({ ...baseClassified, lexicalQuery: 'parity rule' }, baseOptions);
  const ids = new Set(candidates.map((c) => c.knowledgeId));
  ok(ids.has(approved.id), 'approved rule is returned');
  ok(!ids.has(pending.id), 'pending rule must be excluded');
});
