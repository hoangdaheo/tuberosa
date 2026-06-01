import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assembleExtractionInputs, MAX_EXCERPT_LENGTH } from '../src/curation/bootstrap-extract.js';
import type { AtlasInputs } from '../src/atlas/inputs.js';
import type { ProjectArea } from '../src/knowledge-areas/area-model.js';

/** Minimal ProjectArea for tests — all required fields present. */
function makeArea(overrides: Partial<ProjectArea> & Pick<ProjectArea, 'key' | 'label'>): ProjectArea {
  return {
    paths: [],
    knowledgeIds: [],
    atomIds: [],
    labels: [],
    crossingRelations: 0,
    counts: { files: 0, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
    ...overrides,
  };
}

/** Minimal AtlasInputs with the fields needed for bootstrap extraction. */
function makeAtlas(overrides: Partial<AtlasInputs> = {}): AtlasInputs {
  return {
    project: 'tuberosa',
    repoPath: '/repo',
    generatedAt: '2026-06-01T00:00:00.000Z',
    areas: [],
    atoms: [],
    knowledge: [],
    relations: [],
    ledger: [],
    knowledgeGaps: [],
    openConflictCount: 0,
    scripts: {},
    areaDeps: [],
    ...overrides,
  };
}

const RETRIEVAL_AREA = makeArea({
  key: 'src/retrieval',
  label: 'Retrieval',
  paths: ['src/retrieval/service.ts', 'src/retrieval/fusion.ts'],
  counts: { files: 12, knowledge: 3, atoms: 4, verifiedAtoms: 1 },
});

const BASE_SCRIPTS: Record<string, string> = {
  test: 'node --test',
  'eval:retrieval': 'pnpm run eval:retrieval',
  build: 'tsc -p .',
};

// ---------------------------------------------------------------------------
// scripts pass-through
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: scripts pass-through verbatim', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  assert.deepEqual(result.scripts, BASE_SCRIPTS);
});

// ---------------------------------------------------------------------------
// areas mapping
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: areas maps to { key, label, fileCount }', () => {
  const atlas = makeAtlas({ areas: [RETRIEVAL_AREA], scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  assert.deepEqual(result.areas, [{ key: 'src/retrieval', label: 'Retrieval', fileCount: 12 }]);
});

test('assembleExtractionInputs: areas preserves input order', () => {
  const areaA = makeArea({ key: 'src/aaa', label: 'Aaa', counts: { files: 2, knowledge: 0, atoms: 0, verifiedAtoms: 0 } });
  const areaB = makeArea({ key: 'src/bbb', label: 'Bbb', counts: { files: 5, knowledge: 0, atoms: 0, verifiedAtoms: 0 } });
  const atlas = makeAtlas({ areas: [areaB, areaA] });
  const result = assembleExtractionInputs(atlas);
  assert.equal(result.areas[0].key, 'src/bbb');
  assert.equal(result.areas[1].key, 'src/aaa');
});

// ---------------------------------------------------------------------------
// detectedTech
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: detects typescript from tsc command', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  assert.ok(result.detectedTech.includes('typescript'), `expected typescript in ${JSON.stringify(result.detectedTech)}`);
});

test('assembleExtractionInputs: detects pnpm from script command', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  assert.ok(result.detectedTech.includes('pnpm'), `expected pnpm in ${JSON.stringify(result.detectedTech)}`);
});

test('assembleExtractionInputs: detectedTech is sorted alphabetically', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  const sorted = [...result.detectedTech].sort();
  assert.deepEqual(result.detectedTech, sorted);
});

test('assembleExtractionInputs: detectedTech is deduplicated', () => {
  // Multiple mentions of pnpm should yield a single entry
  const scripts = {
    build: 'pnpm tsc',
    test: 'pnpm node --test',
    lint: 'pnpm eslint .',
  };
  const atlas = makeAtlas({ scripts });
  const result = assembleExtractionInputs(atlas);
  const pnpmCount = result.detectedTech.filter((t) => t === 'pnpm').length;
  assert.equal(pnpmCount, 1);
});

test('assembleExtractionInputs: detects react from script command', () => {
  const scripts = { start: 'react-scripts start' };
  const atlas = makeAtlas({ scripts });
  const result = assembleExtractionInputs(atlas);
  assert.ok(result.detectedTech.includes('react'), `expected react in ${JSON.stringify(result.detectedTech)}`);
});

test('assembleExtractionInputs: detects postgres from migrate script', () => {
  const scripts = { migrate: 'node migrate.js' };
  const atlas = makeAtlas({ scripts });
  const result = assembleExtractionInputs(atlas);
  assert.ok(result.detectedTech.includes('postgres'), `expected postgres in ${JSON.stringify(result.detectedTech)}`);
});

test('assembleExtractionInputs: detects postgres from .sql in command', () => {
  const scripts = { 'db:up': 'psql -f schema.sql' };
  const atlas = makeAtlas({ scripts });
  const result = assembleExtractionInputs(atlas);
  assert.ok(result.detectedTech.includes('postgres'), `expected postgres in ${JSON.stringify(result.detectedTech)}`);
});

test('assembleExtractionInputs: does not invent tech without evidence', () => {
  // No scripts = empty detectedTech
  const atlas = makeAtlas({ scripts: {} });
  const result = assembleExtractionInputs(atlas);
  assert.deepEqual(result.detectedTech, []);
});

test('assembleExtractionInputs: .tsv path does not falsely trigger typescript', () => {
  const tsvArea = makeArea({
    key: 'src/data',
    label: 'Data',
    paths: ['src/data/export.tsv'],
    counts: { files: 1, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
  });
  // Non-TS script so detection relies purely on the (anchored) path checks.
  const atlas = makeAtlas({ areas: [tsvArea], scripts: { fmt: 'prettier --write .' } });
  const result = assembleExtractionInputs(atlas);
  assert.ok(
    !result.detectedTech.includes('typescript'),
    `.tsv path should not yield typescript; got ${JSON.stringify(result.detectedTech)}`,
  );
});

// ---------------------------------------------------------------------------
// docExcerpts
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: no docs → no docExcerpts', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas);
  assert.deepEqual(result.docExcerpts, []);
});

test('assembleExtractionInputs: readme doc appears as README.md excerpt', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas, { readme: 'This is a readme.' });
  const entry = result.docExcerpts.find((e) => e.source === 'README.md');
  assert.ok(entry, 'expected a README.md docExcerpt');
  assert.equal(entry!.excerpt, 'This is a readme.');
});

test('assembleExtractionInputs: readmeCommands appears as README.md#Commands excerpt', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS, readmeCommands: '# Commands\npnpm test' });
  const result = assembleExtractionInputs(atlas);
  const entry = result.docExcerpts.find((e) => e.source === 'README.md#Commands');
  assert.ok(entry, 'expected a README.md#Commands docExcerpt');
  assert.ok(entry!.excerpt.includes('Commands'));
});

test('assembleExtractionInputs: contributing doc appears as CONTRIBUTING.md excerpt', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas, { contributing: 'How to contribute.' });
  const entry = result.docExcerpts.find((e) => e.source === 'CONTRIBUTING.md');
  assert.ok(entry, 'expected a CONTRIBUTING.md docExcerpt');
  assert.equal(entry!.excerpt, 'How to contribute.');
});

test('assembleExtractionInputs: long readme text is truncated with ellipsis', () => {
  const longText = 'a'.repeat(2000);
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas, { readme: longText });
  const entry = result.docExcerpts.find((e) => e.source === 'README.md');
  assert.ok(entry, 'expected a README.md docExcerpt');
  // [...excerpt] counts code points; truncation keeps MAX_EXCERPT_LENGTH + the '…' marker.
  assert.ok(
    [...entry!.excerpt].length <= MAX_EXCERPT_LENGTH + 1,
    `excerpt too long: ${[...entry!.excerpt].length}`,
  );
  assert.ok(entry!.excerpt.endsWith('…'), `expected excerpt to end with '…', got: ${entry!.excerpt.slice(-10)}`);
});

test('assembleExtractionInputs: short readme text is NOT truncated', () => {
  const shortText = 'Short readme.';
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas, { readme: shortText });
  const entry = result.docExcerpts.find((e) => e.source === 'README.md');
  assert.ok(entry, 'expected a README.md docExcerpt');
  assert.equal(entry!.excerpt, shortText);
  assert.ok(!entry!.excerpt.endsWith('…'), 'short text should not have ellipsis');
});

test('assembleExtractionInputs: docExcerpts order is readme, readmeCommands, contributing', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS, readmeCommands: '# Commands' });
  const result = assembleExtractionInputs(atlas, {
    readme: 'Readme.',
    contributing: 'Contributing.',
  });
  const sources = result.docExcerpts.map((e) => e.source);
  assert.deepEqual(sources, ['README.md', 'README.md#Commands', 'CONTRIBUTING.md']);
});

test('assembleExtractionInputs: empty docs strings are omitted', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS });
  const result = assembleExtractionInputs(atlas, { readme: '', contributing: '' });
  assert.deepEqual(result.docExcerpts, []);
});

// ---------------------------------------------------------------------------
// recurringHints
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: emits area hint for area with fileCount >= 2', () => {
  const atlas = makeAtlas({ areas: [RETRIEVAL_AREA], scripts: {} });
  const result = assembleExtractionInputs(atlas);
  const areaHint = result.recurringHints.find((h) => h.includes('src/retrieval'));
  assert.ok(areaHint, `expected a hint mentioning src/retrieval; got: ${JSON.stringify(result.recurringHints)}`);
});

test('assembleExtractionInputs: does NOT emit area hint for area with fileCount < 2', () => {
  const tinyArea = makeArea({
    key: 'src/tiny',
    label: 'Tiny',
    counts: { files: 1, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
  });
  const atlas = makeAtlas({ areas: [tinyArea], scripts: {} });
  const result = assembleExtractionInputs(atlas);
  const areaHint = result.recurringHints.find((h) => h.includes('src/tiny'));
  assert.equal(areaHint, undefined);
});

test('assembleExtractionInputs: emits workflow-gate hint for test script', () => {
  const atlas = makeAtlas({ scripts: { test: 'node --test' } });
  const result = assembleExtractionInputs(atlas);
  const hint = result.recurringHints.find((h) => h.includes("'test'"));
  assert.ok(hint, `expected a hint for test script; got: ${JSON.stringify(result.recurringHints)}`);
});

test('assembleExtractionInputs: emits workflow-gate hint for build script', () => {
  const atlas = makeAtlas({ scripts: { build: 'tsc -p .' } });
  const result = assembleExtractionInputs(atlas);
  const hint = result.recurringHints.find((h) => h.includes("'build'"));
  assert.ok(hint, `expected a hint for build script; got: ${JSON.stringify(result.recurringHints)}`);
});

test('assembleExtractionInputs: emits workflow-gate hint for eval:retrieval script', () => {
  const atlas = makeAtlas({ scripts: BASE_SCRIPTS, areas: [RETRIEVAL_AREA] });
  const result = assembleExtractionInputs(atlas);
  const hint = result.recurringHints.find((h) => h.includes("'eval:retrieval'"));
  assert.ok(hint, `expected hint for eval:retrieval; got: ${JSON.stringify(result.recurringHints)}`);
});

test('assembleExtractionInputs: area hint is first, script hint is last', () => {
  // Exactly one qualifying area and one gate script — the structure is pinned:
  // hints[0] must be the area hint, and the final hint must be the script hint.
  const area = makeArea({
    key: 'src/retrieval',
    label: 'Retrieval',
    counts: { files: 12, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
  });
  const atlas = makeAtlas({ areas: [area], scripts: { build: 'tsc -p .' } });
  const result = assembleExtractionInputs(atlas);
  assert.equal(result.recurringHints.length, 2);
  assert.ok(
    result.recurringHints[0].startsWith("Area 'src/retrieval'"),
    `expected first hint to be the area hint; got ${JSON.stringify(result.recurringHints[0])}`,
  );
  assert.ok(
    result.recurringHints.at(-1)!.startsWith("Script 'build'"),
    `expected last hint to be the script hint; got ${JSON.stringify(result.recurringHints.at(-1))}`,
  );
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('assembleExtractionInputs: same input produces identical output', () => {
  const atlas = makeAtlas({ areas: [RETRIEVAL_AREA], scripts: BASE_SCRIPTS, readmeCommands: '# Commands\npnpm test' });
  const docs = { readme: 'A readme about the project.', contributing: 'How to contribute.' };
  const r1 = assembleExtractionInputs(atlas, docs);
  const r2 = assembleExtractionInputs(atlas, docs);
  assert.deepEqual(r1, r2);
});
