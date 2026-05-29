import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { gatherAtlasInputs, type AtlasInputs } from '../src/atlas/inputs.js';
import {
  buildProjectMap,
  buildFlows,
  buildCommands,
  buildRisks,
  buildOpenGaps,
} from '../src/atlas/builders.js';

function emptyInputs(over: Partial<AtlasInputs>): AtlasInputs {
  return {
    project: 'p', repoPath: '/repo', generatedAt: 't', areas: [], atoms: [], knowledge: [],
    relations: [], ledger: [], knowledgeGaps: [], openConflictCount: 0, scripts: {}, areaDeps: [],
    ...over,
  };
}

test('buildProjectMap: renders an area with purpose from top wiki summary + deps', () => {
  const inputs = emptyInputs({
    areas: [{
      key: 'src/retrieval', label: 'Retrieval', paths: ['src/retrieval/service.ts'],
      knowledgeIds: ['k1'], atomIds: ['a1'], labels: [{ type: 'domain', value: 'retrieval' }],
      crossingRelations: 2, counts: { files: 1, knowledge: 1, atoms: 1, verifiedAtoms: 1 },
    }],
    knowledge: [{
      id: 'k1', project: 'p', itemType: 'wiki', title: 'Retrieval', summary: 'Search pipeline area.',
      content: 'c', trustLevel: 80, metadata: { sourcePath: 'src/retrieval/service.ts' }, labels: [], references: [],
      createdAt: 't',
    } as AtlasInputs['knowledge'][number]],
    atoms: [{
      id: 'a1', project: 'p', claim: 'x', type: 'fact', evidence: [],
      trigger: { files: ['src/retrieval/service.ts'], symbols: ['searchContext'] },
      tier: 'verified', reuseCount: 0, status: 'active', scope: 'project',
      audit: { producedBy: 'agent_session', createdAt: 't', updatedAt: 't' },
    } as AtlasInputs['atoms'][number]],
    areaDeps: [{ from: 'src/retrieval', to: 'src/storage', weight: 3 }],
  });
  const md = buildProjectMap(inputs);
  assert.match(md, /## src\/retrieval — Retrieval/);
  assert.match(md, /Search pipeline area\./);
  assert.match(md, /key symbols:.*searchContext/);
  assert.match(md, /→ depends on:.*src\/storage/);
});

test('buildProjectMap: purpose falls back to labels then to no-description note', () => {
  const labelOnly = buildProjectMap(emptyInputs({
    areas: [{
      key: 'src/x', label: 'X', paths: [], knowledgeIds: [], atomIds: [],
      labels: [{ type: 'domain', value: 'storage' }], crossingRelations: 0,
      counts: { files: 0, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
    }],
  }));
  assert.match(labelOnly, /labels: domain\/storage/);

  const none = buildProjectMap(emptyInputs({
    areas: [{
      key: 'src/y', label: 'Y', paths: [], knowledgeIds: [], atomIds: [], labels: [],
      crossingRelations: 0, counts: { files: 0, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
    }],
  }));
  assert.match(none, /\(no description — see open-gaps\.md\)/);
});

test('buildFlows: renders area dependency edges and notes empty co-change', () => {
  const md = buildFlows(emptyInputs({ areaDeps: [{ from: 'src/a', to: 'src/b', weight: 2 }] }));
  assert.match(md, /Area dependency map/);
  assert.match(md, /src\/a → src\/b \(2\)/);
  assert.match(md, /infer-co-change/);
});

test('buildFlows: notes empty dependency map', () => {
  const md = buildFlows(emptyInputs({}));
  assert.match(md, /No cross-area dependencies inferred yet/);
});

test('buildCommands: groups scripts by prefix and includes README section', () => {
  const md = buildCommands(emptyInputs({
    scripts: { build: 'tsc', test: 'node --test', 'eval:retrieval': 'tsx x', backup: 'tsx b', weird: 'echo hi' },
    readmeCommands: '## Commands\n\nrun stuff',
  }));
  assert.match(md, /### Build & Dev[\s\S]*pnpm run build/);
  assert.match(md, /### Test & Eval[\s\S]*pnpm run eval:retrieval[\s\S]*pnpm run test/);
  assert.match(md, /### Data & Maintenance[\s\S]*pnpm run backup/);
  assert.match(md, /### Other[\s\S]*pnpm run weird/);
  assert.match(md, /From README[\s\S]*run stuff/);
});

test('buildRisks: lists gotcha atoms, stale knowledge, and conflict count', () => {
  const md = buildRisks(emptyInputs({
    atoms: [{
      id: 'g1', project: 'p', claim: 'do not lower fail-under', type: 'gotcha', evidence: [],
      trigger: {}, pitfalls: ['masks failures'], tier: 'verified', reuseCount: 0, status: 'active',
      scope: 'project', audit: { producedBy: 'agent_session', createdAt: 't', updatedAt: 't' },
    } as AtlasInputs['atoms'][number]],
    ledger: [{
      project: 'p', path: 'src/a/x.ts', status: 'changed', contentHash: 'h', lastSyncedSha: null,
      priorPaths: [], knowledgeCount: 1, firstSeenAt: 't', lastSeenAt: 't', archivedAt: null, metadata: {}, id: '1',
    }],
    knowledge: [{
      id: 'k1', project: 'p', itemType: 'code_ref', title: 't', summary: '', content: 'c',
      trustLevel: 10, metadata: { sourcePath: 'src/a/x.ts' }, labels: [], references: [], createdAt: 't',
    } as AtlasInputs['knowledge'][number]],
    openConflictCount: 2,
  }));
  assert.match(md, /## Gotchas[\s\S]*do not lower fail-under/);
  assert.match(md, /masks failures/);
  assert.match(md, /## Stale knowledge[\s\S]*src\/a\/x\.ts/);
  assert.match(md, /2 open import conflict/);
});

test('buildOpenGaps: flags undocumented/thin areas, gaps, and unverified atoms', () => {
  const md = buildOpenGaps(emptyInputs({
    areas: [{
      key: 'src/y', label: 'Y', paths: ['src/y/a.ts'], knowledgeIds: [], atomIds: [], labels: [],
      crossingRelations: 0, counts: { files: 1, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
    }],
    knowledgeGaps: [{
      id: 'gp', project: 'p', prompt: 'how does X work', missingSignals: ['file:x'],
      status: 'open', metadata: {}, createdAt: 't',
    } as AtlasInputs['knowledgeGaps'][number]],
    atoms: [{
      id: 'a1', project: 'p', claim: 'unverified claim', type: 'fact', evidence: [], trigger: {},
      tier: 'draft', reuseCount: 0, status: 'active', scope: 'project',
      audit: { producedBy: 'agent_session', createdAt: 't', updatedAt: 't' },
    } as AtlasInputs['atoms'][number]],
  }));
  assert.match(md, /Undocumented areas[\s\S]*src\/y/);
  assert.match(md, /Thin coverage[\s\S]*src\/y/);
  assert.match(md, /Recorded knowledge gaps[\s\S]*how does X work/);
  assert.match(md, /Unverified atoms[\s\S]*unverified claim/);
});

test('atlas builders are deterministic across runs', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a/x.ts', contentHash: 'h', status: 'tracked' });
  const i1 = await gatherAtlasInputs(store, { project: 'p', repoPath: process.cwd(), generatedAt: 't' });
  const i2 = await gatherAtlasInputs(store, { project: 'p', repoPath: process.cwd(), generatedAt: 't' });
  assert.equal(buildProjectMap(i1), buildProjectMap(i2));
  assert.equal(buildOpenGaps(i1), buildOpenGaps(i2));
});
