import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clusterUncuratedAtoms } from '../src/curation/cluster.js';
import type { KnowledgeAtom, Trigger, AtomType } from '../src/types/atoms.js';

function atom(over: Partial<KnowledgeAtom> & { id: string }): KnowledgeAtom {
  return {
    project: 'p',
    claim: 'c',
    type: 'fact' as AtomType,
    evidence: [],
    trigger: {} as Trigger,
    tier: 'draft',
    reuseCount: 0,
    status: 'active',
    scope: 'project',
    audit: { producedBy: 'agent_session', createdAt: 't', updatedAt: 't' },
    ...over,
  };
}

test('clusterUncuratedAtoms: atoms about the same concern cluster together', () => {
  const atoms = [
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({ id: 'a2', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo', 'useCallback'] } }),
    atom({ id: 'a3', trigger: { files: ['src/components/X.tsx'], symbols: ['useCallback'] } }),
  ];

  const clusters = clusterUncuratedAtoms(atoms);

  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].atoms.map((a) => a.id).sort(),
    ['a1', 'a2', 'a3'],
  );
  // sharedTrigger = intersection of members; only the file is shared by all three.
  assert.deepEqual(clusters[0].sharedTrigger.files, ['src/components/X.tsx']);
  assert.equal(clusters[0].suggestedScope, 'project');
});

test('clusterUncuratedAtoms: unrelated atom stays a singleton cluster', () => {
  const atoms = [
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({ id: 'a2', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({ id: 'z9', trigger: { files: ['src/server/db.ts'], symbols: ['connectPool'] } }),
  ];

  const clusters = clusterUncuratedAtoms(atoms);

  assert.equal(clusters.length, 2);
  // clusters sorted by first atom id; the X.tsx pair comes first.
  assert.deepEqual(clusters[0].atoms.map((a) => a.id).sort(), ['a1', 'a2']);
  assert.deepEqual(clusters[1].atoms.map((a) => a.id), ['z9']);
});

test('clusterUncuratedAtoms: excludes atoms already distilled into a convention', () => {
  const atoms = [
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({
      id: 'a2',
      trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] },
      metadata: { distilledIntoAtomId: 'conv-1' },
    }),
  ];

  const clusters = clusterUncuratedAtoms(atoms);

  const ids = clusters.flatMap((c) => c.atoms.map((a) => a.id));
  assert.deepEqual(ids, ['a1']);
});

test('clusterUncuratedAtoms: excludes convention-type atoms (already curated output)', () => {
  const atoms = [
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({
      id: 'a2',
      type: 'convention',
      trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] },
    }),
  ];

  const clusters = clusterUncuratedAtoms(atoms);

  const ids = clusters.flatMap((c) => c.atoms.map((a) => a.id));
  assert.deepEqual(ids, ['a1']);
});

test('clusterUncuratedAtoms: excludes non-active atoms (superseded raw material)', () => {
  const atoms = [
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({
      id: 'a2',
      status: 'superseded',
      trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] },
    }),
  ];

  const clusters = clusterUncuratedAtoms(atoms);

  const ids = clusters.flatMap((c) => c.atoms.map((a) => a.id));
  assert.deepEqual(ids, ['a1']);
});

test('clusterUncuratedAtoms: deterministic across repeated calls', () => {
  const atoms = [
    atom({ id: 'a3', trigger: { files: ['src/components/X.tsx'], symbols: ['useCallback'] } }),
    atom({ id: 'a1', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo'] } }),
    atom({ id: 'z9', trigger: { files: ['src/server/db.ts'], symbols: ['connectPool'] } }),
    atom({ id: 'a2', trigger: { files: ['src/components/X.tsx'], symbols: ['useMemo', 'useCallback'] } }),
  ];

  const first = clusterUncuratedAtoms(atoms);
  const second = clusterUncuratedAtoms(atoms);

  assert.deepEqual(first, second);
});
