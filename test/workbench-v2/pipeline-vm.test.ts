import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { pipelineSteps } from '../../src/workbench-v2/viz/pipeline-flow-vm.js';

test('pipelineSteps has 10 stages in canonical order', () => {
  const steps = pipelineSteps();
  equal(steps.length, 10);
  deepEqual(
    steps.map((s) => s.id),
    ['receive', 'classify', 'rewrite', 'search', 'fuse', 'rerank', 'adjust', 'fit', 'assemble', 'deep'],
  );
});

test('stage state derives from timings', () => {
  const steps = pipelineSteps({ classify: 12, rewrite: 0, fuse: 8 });
  const byId = Object.fromEntries(steps.map((s) => [s.id, s.state]));
  equal(byId.receive, 'pending');
  equal(byId.classify, 'done');
  equal(byId.rewrite, 'skipped');
  equal(byId.fuse, 'done');
  equal(byId.deep, 'pending');
});
