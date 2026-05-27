import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { AtomExtractor } from '../src/atoms/extractor.js';

// AKIAIOSFODNN7EXAMPLE matches the aws_access_key SECRET_PATTERN
// (verified against src/security/knowledge-safety.ts and test/knowledge-safety.test.ts).
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

test('AtomExtractor redacts secrets from atom claim/verification before storage', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: `Use the deploy key ${AWS_KEY} when rotating credentials.`,
    type: 'procedure',
    evidence: [{ kind: 'commit', sha: 'deadbeef', message: `set key ${AWS_KEY}` }],
    trigger: { errors: ['credential rotation failure'] },
    verification: { command: `aws configure set aws_access_key_id ${AWS_KEY}` },
    pitfalls: [`do not commit ${AWS_KEY} to source control`],
  }]);
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-secret',
    sessionPrompt: 'rotate the deploy credentials',
  });

  assert.equal(result.stored.length, 1, JSON.stringify(result.rejected));
  const atom = result.stored[0];
  assert.ok(!atom.claim.includes(AWS_KEY), `claim still contains secret: ${atom.claim}`);
  assert.ok(atom.claim.includes('[REDACTED'), `claim should carry redaction marker: ${atom.claim}`);
  assert.ok(!(atom.verification?.command ?? '').includes(AWS_KEY), 'verification.command still contains secret');
  assert.ok(!(atom.pitfalls?.[0] ?? '').includes(AWS_KEY), 'pitfall still contains secret');
  const commitEvidence = atom.evidence.find((e) => e.kind === 'commit');
  assert.ok(commitEvidence && commitEvidence.kind === 'commit');
  assert.ok(!(commitEvidence.message ?? '').includes(AWS_KEY), 'evidence message still contains secret');

  // Persisted copy is also redacted.
  const fetched = await store.getAtom(atom.id);
  assert.ok(fetched && !fetched.claim.includes(AWS_KEY));
});
