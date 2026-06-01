import test from 'node:test';
import { equal } from 'node:assert/strict';
import { parseRetrievalEvalFixture } from '../src/evaluation/fixture-loader.js';

// Phase 2 — the loader must forward `scope` and `teamId` from a fixture atom so
// that team-scoped convention coverage can be expressed in eval fixtures. Without
// this, every fixture atom would default to project scope and team conventions
// could never be seeded.
test('fixture loader forwards scope and teamId for team convention atoms', () => {
  const fixture = parseRetrievalEvalFixture({
    name: 'convention forwarding fixture',
    project: 'newsletter-app',
    knowledge: [],
    atoms: [
      {
        evalId: 'team-named-exports',
        claim: 'Use named exports across the codebase; avoid default exports.',
        type: 'convention',
        scope: 'team',
        teamId: 'default',
        tier: 'verified',
        status: 'active',
        trigger: { taskTypes: ['implementation'], symbols: ['export'] },
      },
      {
        evalId: 'proj-only-billing-rotation',
        claim: 'Rotate the billing webhook secret via the ops runbook only.',
        type: 'convention',
        scope: 'project',
        tier: 'verified',
        status: 'active',
        trigger: { taskTypes: ['implementation'], businessAreas: ['billing-internal-xyz'] },
      },
    ],
    cases: [
      {
        id: 'noop',
        prompt: 'noop case so the fixture parses with a non-empty cases array.',
      },
    ],
  });

  const team = fixture.atoms?.find((atom) => atom.evalId === 'team-named-exports');
  const project = fixture.atoms?.find((atom) => atom.evalId === 'proj-only-billing-rotation');

  equal(team?.scope, 'team');
  equal(team?.teamId, 'default');
  equal(team?.type, 'convention');
  equal(project?.scope, 'project');
  equal(project?.teamId, undefined);
});
