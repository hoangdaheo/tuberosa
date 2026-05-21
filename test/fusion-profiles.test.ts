import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  coverageProfileFor,
  effectiveSourceWeight,
  effectiveTaskItemTypeBoosts,
  graphHopMultiplier,
  resetRetrievalPolicyCache,
  setRetrievalPolicy,
} from '../src/retrieval/policy.js';
import type { RetrievalPolicy } from '../src/retrieval/policy.js';

function clone(): RetrievalPolicy {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as RetrievalPolicy;
}

describe('RetrievalPolicy Phase 4 helpers', () => {
  beforeEach(() => {
    setRetrievalPolicy(clone());
  });
  afterEach(() => {
    resetRetrievalPolicyCache();
  });

  it('effectiveSourceWeight applies the per-task delta on top of the global weight', () => {
    const policy = clone();
    policy.sourceWeights.metadata = 1.0;
    policy.taskProfiles = { debugging: { sourceWeights: { metadata: 0.2 } } };
    setRetrievalPolicy(policy);
    assert.equal(effectiveSourceWeight(policy, 'metadata', 'debugging'), 1.2);
    // task without a profile entry → base weight
    assert.equal(effectiveSourceWeight(policy, 'metadata', 'exploration'), 1.0);
  });

  it('effectiveSourceWeight returns the base when useTaskProfiles=false', () => {
    const policy = clone();
    policy.useTaskProfiles = false;
    policy.taskProfiles = { debugging: { sourceWeights: { metadata: 0.5 } } };
    setRetrievalPolicy(policy);
    assert.equal(effectiveSourceWeight(policy, 'metadata', 'debugging'), policy.sourceWeights.metadata);
  });

  it('effectiveTaskItemTypeBoosts merges per-task boosts with the global list', () => {
    const policy = clone();
    policy.taskItemTypeBoosts = [{ taskType: 'debugging', itemTypes: ['bugfix'], bonus: 0.16 }];
    policy.taskProfiles = { debugging: { itemTypeBoosts: [{ itemTypes: ['memory'], bonus: 0.04 }] } };
    setRetrievalPolicy(policy);
    const boosts = effectiveTaskItemTypeBoosts(policy, 'debugging');
    assert.equal(boosts.length, 2);
    assert.ok(boosts.some((entry) => entry.itemTypes.includes('memory') && entry.bonus === 0.04));
  });

  it('coverageProfileFor returns the per-task override when present', () => {
    const policy = clone();
    policy.coverageProfiles = { debugging: { error: 0.4 } };
    setRetrievalPolicy(policy);
    const debugging = coverageProfileFor(policy, 'debugging');
    assert.equal(debugging.error, 0.4);
    assert.equal(debugging.file, policy.coverageGlobal.file, 'unspecified keys fall back to the global');
  });

  it('coverageProfileFor returns coverageGlobal when useCoverageProfiles=false', () => {
    const policy = clone();
    policy.useCoverageProfiles = false;
    policy.coverageProfiles = { debugging: { error: 0.4 } };
    setRetrievalPolicy(policy);
    const debugging = coverageProfileFor(policy, 'debugging');
    assert.equal(debugging.error, policy.coverageGlobal.error);
  });

  it('graphHopMultiplier multiplies hop weight by the relation-kind multiplier', () => {
    const policy = clone();
    policy.graphHopWeights = { target: 1.0, seed: 0.5, depth2: 0.25 };
    policy.relationKindMultipliers = { supersedes: 1.5, mentions_file: 0.5 };
    setRetrievalPolicy(policy);
    assert.equal(graphHopMultiplier(policy, 'target', 'supersedes'), 1.5);
    assert.equal(graphHopMultiplier(policy, 'seed', 'mentions_file'), 0.25);
    assert.equal(graphHopMultiplier(policy, 'depth2', 'references'), 0.25);
  });

  it('graphHopMultiplier defaults to 1.0 for unknown relation kinds', () => {
    const policy = clone();
    policy.graphHopWeights = { target: 0.9, seed: 0.6 };
    policy.relationKindMultipliers = {};
    setRetrievalPolicy(policy);
    assert.equal(graphHopMultiplier(policy, 'target', 'related_to'), 0.9);
  });
});
