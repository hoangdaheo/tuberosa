import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { type AtlasInputs } from '../src/atlas/inputs.js';
import { buildConventions } from '../src/atlas/builders.js';

function emptyInputs(over: Partial<AtlasInputs>): AtlasInputs {
  return {
    project: 'p', repoPath: '/repo', generatedAt: 't', areas: [], atoms: [], knowledge: [],
    relations: [], ledger: [], knowledgeGaps: [], openConflictCount: 0, scripts: {}, areaDeps: [],
    ...over,
  };
}

function convention(over: Partial<AtlasInputs['atoms'][number]>): AtlasInputs['atoms'][number] {
  return {
    id: 'c1', project: 'p', claim: 'a convention', type: 'convention', evidence: [], trigger: {},
    tier: 'verified', reuseCount: 0, status: 'active', scope: 'project',
    audit: { producedBy: 'agent_session', createdAt: 't', updatedAt: 't' },
    ...over,
  } as AtlasInputs['atoms'][number];
}

test('buildConventions: deterministic across runs', () => {
  const inputs = emptyInputs({
    atoms: [
      convention({ id: 'c1', claim: 'use 2-space indent', scope: 'team', metadata: { category: 'code_style' } }),
      convention({ id: 'c2', claim: 'prefer async/await', scope: 'project', metadata: { category: 'patterns' } }),
    ],
  });
  assert.equal(buildConventions(inputs), buildConventions(inputs));
});

test('buildConventions: team convention renders under Team + category sub-grouping with claim', () => {
  const md = buildConventions(emptyInputs({
    atoms: [convention({ id: 'c1', claim: 'use 2-space indent', scope: 'team', metadata: { category: 'code_style' } })],
  }));
  assert.match(md, /## Team/);
  assert.match(md, /code_style/);
  assert.match(md, /use 2-space indent/);
});

test('buildConventions: convention without metadata.category renders under "other"', () => {
  const md = buildConventions(emptyInputs({
    atoms: [convention({ id: 'c1', claim: 'no category here', scope: 'project' })],
  }));
  assert.match(md, /other/);
  assert.match(md, /no category here/);
});

test('buildConventions: excludes non-convention and non-active atoms', () => {
  const md = buildConventions(emptyInputs({
    atoms: [
      convention({ id: 'c1', claim: 'active convention', scope: 'project', metadata: { category: 'patterns' } }),
      convention({ id: 'c2', claim: 'archived convention', scope: 'project', status: 'archived', metadata: { category: 'patterns' } }),
      { ...convention({ id: 'f1', scope: 'project' }), claim: 'just a fact', type: 'fact' } as AtlasInputs['atoms'][number],
    ],
  }));
  assert.match(md, /active convention/);
  assert.doesNotMatch(md, /archived convention/);
  assert.doesNotMatch(md, /just a fact/);
});

test('buildConventions: empty input yields stable placeholder', () => {
  const md = buildConventions(emptyInputs({}));
  assert.match(md, /No conventions captured yet/);
  assert.equal(md, buildConventions(emptyInputs({})));
});

test('buildConventions: renders author and numbered steps from metadata when present', () => {
  const md = buildConventions(emptyInputs({
    atoms: [convention({
      id: 'c1', claim: 'release procedure', scope: 'project',
      metadata: { category: 'process', author: 'nash', steps: ['cut branch', 'run eval', 'merge'] },
    })],
  }));
  assert.match(md, /release procedure/);
  assert.match(md, /nash/);
  assert.match(md, /1\. cut branch/);
  assert.match(md, /3\. merge/);
});
