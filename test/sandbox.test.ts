import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateSandboxFixture } from '../eval/sandbox/generator.js';
import { buildSandboxPrompts } from '../eval/sandbox/prompts.js';

test('sandbox corpus generator is deterministic for a fixed seed', () => {
  const a = generateSandboxFixture(42);
  const b = generateSandboxFixture(42);
  assert.equal(a.knowledge.length, b.knowledge.length);
  assert.equal(a.relations.length, b.relations.length);
  for (let i = 0; i < a.knowledge.length; i += 1) {
    assert.equal(a.knowledge[i]!.sandboxId, b.knowledge[i]!.sandboxId);
    assert.equal(a.knowledge[i]!.title, b.knowledge[i]!.title);
    assert.equal(a.knowledge[i]!.project, b.knowledge[i]!.project);
    assert.equal(a.knowledge[i]!.itemType, b.knowledge[i]!.itemType);
  }
});

test('sandbox corpus covers all six tiers', () => {
  const fixture = generateSandboxFixture();
  const tiers = new Set(fixture.knowledge.map((item) => item.tier));
  for (const expected of ['A', 'B', 'C', 'D', 'E', 'F']) {
    assert.ok(tiers.has(expected as 'A'), `Tier ${expected} must be present`);
  }
});

test('sandbox corpus emits supersedes relations for stale pairs', () => {
  const fixture = generateSandboxFixture();
  const supersedes = fixture.relations.filter((relation) => relation.relationType === 'supersedes');
  assert.ok(supersedes.length > 0, 'Expected at least one supersedes relation');
  for (const relation of supersedes) {
    const from = fixture.knowledge.find((item) => item.sandboxId === relation.fromSandboxId);
    const to = fixture.knowledge.find((item) => item.sandboxId === relation.toSandboxId);
    assert.ok(from && from.tier === 'C');
    assert.ok(to && to.tier === 'C');
  }
});

test('sandbox prompt set is non-empty and references existing knowledge', () => {
  const fixture = generateSandboxFixture();
  const { prompts } = buildSandboxPrompts(fixture);
  assert.ok(prompts.length >= 24, `Expected >=24 prompts, got ${prompts.length}`);
  const sandboxIds = new Set(fixture.knowledge.map((item) => item.sandboxId));
  for (const prompt of prompts) {
    for (const id of prompt.expectedSelectedSandboxIds) {
      assert.ok(sandboxIds.has(id), `expectedSelected ${id} must exist`);
    }
    for (const id of prompt.forbiddenSandboxIds) {
      assert.ok(sandboxIds.has(id), `forbidden ${id} must exist`);
    }
  }
});

test('sandbox prompt set covers all canonical task types', () => {
  const fixture = generateSandboxFixture();
  const { prompts } = buildSandboxPrompts(fixture);
  const taskTypes = new Set(prompts.map((prompt) => prompt.taskType));
  for (const expected of ['implementation', 'debugging', 'planning', 'review', 'exploration', 'testing', 'refactor']) {
    assert.ok(taskTypes.has(expected as 'implementation'), `taskType ${expected} must be exercised`);
  }
});

test('sandbox corpus includes adversarial content that should trip safety filters', () => {
  const fixture = generateSandboxFixture();
  const adversarial = fixture.knowledge.filter((item) => item.tier === 'E');
  assert.ok(adversarial.length >= 10, 'Expected at least 10 adversarial items');
  const hasInjectionLanguage = adversarial.some((item) => /ignore (?:all )?previous instructions/i.test(item.content));
  assert.ok(hasInjectionLanguage, 'Adversarial tier must include prompt-injection language');
});
