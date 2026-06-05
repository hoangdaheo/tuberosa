import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ATOM_EXTRACTION_SYSTEM_PROMPT,
  ATOM_UTILITY_SYSTEM_PROMPT,
  atomExtractionSchema,
  atomUtilitySchema,
  parseAtomUtilityVerdict,
  parseExtractedAtoms,
} from '../src/model/atom-extraction.js';
import { ModelProviderError } from '../src/errors.js';

const VALID_ATOM = {
  claim: 'Run pnpm run eval:retrieval before changing fusion weights.',
  type: 'convention',
  evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
  trigger: { files: ['src/retrieval/fusion.ts'], taskTypes: ['refactor'] },
  verification: { command: 'pnpm run eval:retrieval' },
  pitfalls: ['Do not lower eval thresholds to make tests pass.'],
};

test('prompt names the atom contract', () => {
  assert.ok(ATOM_EXTRACTION_SYSTEM_PROMPT.includes('generalizable'));
  assert.ok(ATOM_EXTRACTION_SYSTEM_PROMPT.includes('240'));
  assert.ok(ATOM_UTILITY_SYSTEM_PROMPT.includes('generalizable'));
});

test('schemas have an object root (required by OpenAI strict + Ollama format)', () => {
  assert.equal(atomExtractionSchema().type, 'object');
  assert.equal(atomUtilitySchema().type, 'object');
});

test('parseExtractedAtoms keeps a fully valid atom', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({ atoms: [VALID_ATOM] }));
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.type, 'convention');
  assert.deepEqual(atoms[0]!.evidence, [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }]);
  assert.equal(atoms[0]!.verification?.command, 'pnpm run eval:retrieval');
});

test('parseExtractedAtoms drops invalid entries without failing the batch', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({
    atoms: [
      VALID_ATOM,
      { claim: '', type: 'fact', evidence: [], trigger: {} },          // empty claim
      { claim: 'Bad type survives nothing.', type: 'opinion', evidence: [], trigger: {} }, // bad type
      'not-an-object',
    ],
  }));
  assert.equal(atoms.length, 1);
});

test('parseExtractedAtoms strips nulls and malformed evidence, keeps valid kinds', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({
    atoms: [{
      claim: 'Evidence entries are validated per kind.',
      type: 'fact',
      evidence: [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'file' },                            // missing path -> dropped
        { kind: 'commit', sha: 'abc123' },
        { kind: 'teleport', uri: 'x' },              // unknown kind -> dropped
        null,
      ],
      trigger: { errors: ['E1', null, 7], files: null },
      verification: null,
      pitfalls: null,
    }],
  }));
  assert.equal(atoms.length, 1);
  assert.deepEqual(atoms[0]!.evidence, [
    { kind: 'file', path: 'src/a.ts' },
    { kind: 'commit', sha: 'abc123' },
  ]);
  assert.deepEqual(atoms[0]!.trigger.errors, ['E1']);
  assert.equal(atoms[0]!.verification, undefined);
  assert.equal(atoms[0]!.pitfalls, undefined);
});

test('parseExtractedAtoms clamps claim length to 240 and caps at 8 atoms', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...VALID_ATOM,
    claim: `Atom number ${i} ${'x'.repeat(300)}`,
  }));
  const atoms = parseExtractedAtoms(JSON.stringify({ atoms: many }));
  assert.equal(atoms.length, 8);
  assert.ok(atoms[0]!.claim.length <= 240);
});

test('parseExtractedAtoms throws ModelProviderError on non-JSON', () => {
  assert.throws(() => parseExtractedAtoms('not json'), ModelProviderError);
});

test('parseExtractedAtoms returns [] when atoms key is missing', () => {
  assert.deepEqual(parseExtractedAtoms('{}'), []);
});

test('parseAtomUtilityVerdict normalizes fields', () => {
  const verdict = parseAtomUtilityVerdict(JSON.stringify({
    generalizable: true,
    reason: 'r'.repeat(500),
    confidence: 1.7,
  }));
  assert.equal(verdict.generalizable, true);
  assert.ok(verdict.reason.length <= 200);
  assert.equal(verdict.confidence, 1);
});

test('parseAtomUtilityVerdict throws ModelProviderError on non-JSON', () => {
  assert.throws(() => parseAtomUtilityVerdict('nope'), ModelProviderError);
});
