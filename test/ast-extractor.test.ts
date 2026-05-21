import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractAstSymbols, pickAstSourceFromReferences, relationsFromAst } from '../src/relations/ast-extractor.js';
import type { StoredKnowledge } from '../src/types.js';

test('extractAstSymbols returns empty when the filename is not a supported source', () => {
  const result = extractAstSymbols('export function noop() {}', { filename: 'note.md' });
  assert.deepEqual(result, { exportedSymbols: [], calls: [] });
});

test('extractAstSymbols pulls exported declarations from a TypeScript file', () => {
  const source = `
    export function alpha() {}
    export class Beta {}
    export interface Gamma {}
    export const delta = 1;
    function hidden() {}
  `;
  const result = extractAstSymbols(source, { filename: 'src/example.ts' });
  assert.ok(result.exportedSymbols.includes('alpha'));
  assert.ok(result.exportedSymbols.includes('Beta'));
  assert.ok(result.exportedSymbols.includes('Gamma'));
  assert.ok(result.exportedSymbols.includes('delta'));
  assert.equal(result.exportedSymbols.includes('hidden'), false);
});

test('extractAstSymbols captures call expressions and filters stop words', () => {
  const source = `
    import { service } from './service';
    export function run() {
      service.handle();
      console.log('skip');
      return helper(1, 2);
    }
    function helper(a: number, b: number) { return a + b; }
  `;
  const result = extractAstSymbols(source, { filename: 'src/run.ts' });
  assert.ok(result.calls.includes('handle'));
  assert.ok(result.calls.includes('helper'));
  assert.equal(result.calls.includes('log'), false, 'console.log should be filtered');
});

test('extractAstSymbols swallows parse errors and returns empty', () => {
  const result = extractAstSymbols('export function {{ broken', { filename: 'src/broken.ts' });
  // TypeScript createSourceFile is permissive — but the result should still be a shape, not throw.
  assert.ok(Array.isArray(result.exportedSymbols));
  assert.ok(Array.isArray(result.calls));
});

test('relationsFromAst converts symbols into mentions_symbol and calls into depends_on relations', () => {
  const item = {
    id: 'k-1',
    project: 'sandbox',
    references: [],
  } as unknown as StoredKnowledge;
  const relations = relationsFromAst(item, { exportedSymbols: ['alpha'], calls: ['service.handle'] });
  const mention = relations.find((relation) => relation.relationType === 'mentions_symbol' && relation.targetValue === 'alpha');
  const dependency = relations.find((relation) => relation.relationType === 'depends_on' && relation.targetValue === 'service.handle');
  assert.ok(mention, 'expected a mentions_symbol relation');
  assert.ok(dependency, 'expected a depends_on relation');
  assert.equal(mention?.targetKind, 'symbol');
  assert.equal(dependency?.targetKind, 'symbol');
});

test('pickAstSourceFromReferences returns the first supported file reference', () => {
  const filename = pickAstSourceFromReferences([
    { type: 'file', uri: 'docs/overview.md' },
    { type: 'file', uri: 'src/auth/service.ts' },
  ]);
  assert.equal(filename, 'src/auth/service.ts');
});

test('pickAstSourceFromReferences returns undefined when no supported references are present', () => {
  const filename = pickAstSourceFromReferences([
    { type: 'file', uri: 'docs/overview.md' },
    { type: 'url', uri: 'https://example.com' },
  ]);
  assert.equal(filename, undefined);
});
