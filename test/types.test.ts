import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { CandidateSource } from '../src/types.js';

const CANDIDATE_SOURCES: CandidateSource[] = ['lexical', 'vector', 'metadata', 'memory', 'graph'];

test('every CandidateSource value has a producer in both KnowledgeStore implementations', () => {
  const postgresSource = readFileSync('src/storage/postgres-store.ts', 'utf8');
  const memorySource = readFileSync('src/storage/memory-store.ts', 'utf8');

  for (const source of CANDIDATE_SOURCES) {
    const literal = `'${source}'`;
    assert.ok(
      postgresSource.includes(`candidateSelect(${literal}`),
      `PostgresKnowledgeStore is missing candidateSelect(${literal}, ...). CandidateSource '${source}' has no postgres producer.`,
    );
    assert.ok(
      memorySource.includes(literal),
      `MemoryKnowledgeStore is missing a producer that tags candidates with source ${literal}.`,
    );
  }
});
