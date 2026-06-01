import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  expandLabelsThroughOntology,
  expandOntologyValue,
  isOntologyMatch,
  ontologyAxisFromLabelType,
} from '../src/relations/ontology.js';

test('ontologyAxisFromLabelType returns the matching axis for ontology label types only', () => {
  assert.equal(ontologyAxisFromLabelType('technology'), 'technology');
  assert.equal(ontologyAxisFromLabelType('business_area'), 'business_area');
  assert.equal(ontologyAxisFromLabelType('domain'), 'domain');
  assert.equal(ontologyAxisFromLabelType('file'), undefined);
  assert.equal(ontologyAxisFromLabelType('symbol'), undefined);
});

test('expandOntologyValue resolves ancestors for nested technology nodes', () => {
  const result = expandOntologyValue('technology', 'pgvector');
  assert.equal(result.matched, true);
  assert.ok(result.ancestors.includes('postgres'));
  assert.ok(result.ancestors.includes('db'));
});

test('expandOntologyValue returns empty ancestors for root nodes', () => {
  const result = expandOntologyValue('technology', 'frontend');
  assert.equal(result.matched, true);
  assert.deepEqual(result.ancestors, []);
});

test('expandOntologyValue returns matched=false for unknown values', () => {
  const result = expandOntologyValue('technology', 'kafka');
  assert.equal(result.matched, false);
});

test('expandLabelsThroughOntology adds ancestor labels with reduced weight and ontology provenance', () => {
  const labels = expandLabelsThroughOntology([
    { type: 'technology', value: 'pgvector', weight: 0.9 },
  ]);
  assert.equal(labels.find((label) => label.value === 'pgvector')?.weight, 0.9);
  const postgres = labels.find((label) => label.value === 'postgres');
  const db = labels.find((label) => label.value === 'db');
  assert.ok(postgres, 'postgres ancestor label should be added');
  assert.ok(db, 'db ancestor label should be added');
  assert.equal(postgres?.provenance?.source, 'ontology');
  assert.ok((db?.weight ?? 1) <= (postgres?.weight ?? 0));
});

test('expandLabelsThroughOntology is a no-op when enabled=false', () => {
  const labels = expandLabelsThroughOntology(
    [{ type: 'technology', value: 'pgvector', weight: 0.9 }],
    { enabled: false },
  );
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.value, 'pgvector');
});

test('expandLabelsThroughOntology leaves non-ontology label types untouched', () => {
  const labels = expandLabelsThroughOntology([
    { type: 'symbol', value: 'AuthService', weight: 1 },
    { type: 'file', value: 'src/auth/service.ts', weight: 0.9 },
  ]);
  assert.equal(labels.length, 2);
});

test('isOntologyMatch returns true for ancestor terms and false for unrelated terms', () => {
  assert.equal(isOntologyMatch('business_area', 'paywall', 'billing'), true);
  assert.equal(isOntologyMatch('business_area', 'paywall', 'auth'), false);
  assert.equal(isOntologyMatch('business_area', 'paywall', 'paywall'), true);
});
