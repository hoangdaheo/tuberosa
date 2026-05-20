import type { KnowledgeItemType, LabelType, TaskType } from '../../src/types.js';
import type { SandboxFixture, SandboxKnowledge, SandboxProject } from './generator.js';

export interface SandboxPrompt {
  id: string;
  prompt: string;
  taskType: TaskType;
  project?: string;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  expectedSelectedSandboxIds: string[];
  forbiddenSandboxIds: string[];
  expectedItemTypes?: KnowledgeItemType[];
  expectedLabels?: Array<{ type: LabelType; value: string }>;
  expectedNoiseFilteredSandboxIds: string[];
  groundingFacts: Array<{ description: string; weight: number; terms: string[] }>;
}

export interface SandboxPromptSet {
  prompts: SandboxPrompt[];
}

export function buildSandboxPrompts(fixture: SandboxFixture): SandboxPromptSet {
  const prompts: SandboxPrompt[] = [];

  for (const project of fixture.projects) {
    prompts.push(...buildProjectPrompts(project, fixture));
  }

  prompts.push(...buildCrossProjectPrompts(fixture));

  return { prompts };
}

function buildProjectPrompts(project: SandboxProject, fixture: SandboxFixture): SandboxPrompt[] {
  const out: SandboxPrompt[] = [];
  const goldByProject = fixture.knowledge.filter((item) => item.tier === 'A' && item.project === project.id);
  const stalePairs = collectStalePairs(project.id, fixture);
  const duplicatePairs = collectDuplicatePairs(project.id, fixture);
  const noise = fixture.knowledge.filter((item) => item.tier === 'B' && item.project === project.id);
  const adversarial = fixture.knowledge.filter((item) => item.tier === 'E' && item.project === project.id);

  // Implementation prompt — find a gold code_ref or workflow about a specific symbol
  const implementGold = goldByProject.find((item) => item.itemType === 'code_ref') ?? goldByProject[0];
  if (implementGold) {
    const symbol = findLabel(implementGold, 'symbol') ?? project.symbols[0];
    const file = findLabel(implementGold, 'file') ?? project.files[0];
    out.push({
      id: `${project.id}-implement-${symbol}`,
      prompt: `Implement updates to ${symbol} in ${file} for the ${project.domain} flow.`,
      taskType: 'implementation',
      project: project.id,
      files: [file],
      symbols: [symbol],
      expectedSelectedSandboxIds: [implementGold.sandboxId],
      forbiddenSandboxIds: noise.slice(0, 4).map((item) => item.sandboxId),
      expectedItemTypes: ['code_ref', 'spec', 'workflow'],
      expectedLabels: [
        { type: 'symbol', value: symbol },
        { type: 'file', value: file },
        { type: 'project', value: project.id },
      ],
      expectedNoiseFilteredSandboxIds: [...noise.slice(0, 4), ...adversarial.slice(0, 1)].map((item) => item.sandboxId),
      groundingFacts: [
        { description: `mentions ${symbol}`, weight: 0.4, terms: [symbol] },
        { description: `references ${file}`, weight: 0.3, terms: [file] },
        { description: `covers ${project.domain} business area`, weight: 0.3, terms: [project.domain] },
      ],
    });
  }

  // Debugging prompt — error code
  const debugGold = goldByProject.find((item) => item.itemType === 'bugfix') ?? goldByProject[1] ?? goldByProject[0];
  if (debugGold) {
    const errorCode = findLabel(debugGold, 'error') ?? project.errors[0];
    const symbol = findLabel(debugGold, 'symbol') ?? project.symbols[0];
    out.push({
      id: `${project.id}-debug-${errorCode}`,
      prompt: `Debug ${errorCode} appearing when ${symbol} executes in ${project.domain}. What prior fixes apply?`,
      taskType: 'debugging',
      project: project.id,
      errors: [errorCode],
      symbols: [symbol],
      expectedSelectedSandboxIds: [debugGold.sandboxId],
      forbiddenSandboxIds: noise.slice(0, 3).map((item) => item.sandboxId),
      expectedItemTypes: ['bugfix', 'memory', 'workflow'],
      expectedLabels: [
        { type: 'error', value: errorCode },
        { type: 'project', value: project.id },
      ],
      expectedNoiseFilteredSandboxIds: noise.slice(0, 3).map((item) => item.sandboxId),
      groundingFacts: [
        { description: `error ${errorCode}`, weight: 0.5, terms: [errorCode] },
        { description: `mentions ${symbol}`, weight: 0.3, terms: [symbol] },
        { description: `prior fix recorded`, weight: 0.2, terms: ['fix', 'resolved'] },
      ],
    });
  }

  // Planning prompt — needs the spec
  const planningGold = goldByProject.find((item) => item.itemType === 'spec') ?? goldByProject.find((item) => item.itemType === 'wiki');
  if (planningGold) {
    out.push({
      id: `${project.id}-plan`,
      prompt: `Plan the next iteration of the ${project.domain} workflow in ${project.id}. What spec and wiki context applies?`,
      taskType: 'planning',
      project: project.id,
      expectedSelectedSandboxIds: [planningGold.sandboxId],
      forbiddenSandboxIds: noise.slice(0, 3).map((item) => item.sandboxId),
      expectedItemTypes: ['spec', 'wiki', 'workflow'],
      expectedLabels: [
        { type: 'project', value: project.id },
        { type: 'domain', value: project.domain },
      ],
      expectedNoiseFilteredSandboxIds: noise.slice(0, 3).map((item) => item.sandboxId),
      groundingFacts: [
        { description: `addresses ${project.domain}`, weight: 0.5, terms: [project.domain] },
        { description: `applies to project ${project.id}`, weight: 0.5, terms: [project.id] },
      ],
    });
  }

  // Continuation prompt — stale should be suppressed
  if (stalePairs.length > 0) {
    const pair = stalePairs[0];
    const symbol = findLabel(pair.current, 'symbol') ?? project.symbols[0];
    out.push({
      id: `${project.id}-continuation-${pair.current.sandboxId}`,
      prompt: `Continue the ${symbol} ${project.domain} runbook. Use the current workflow, not the legacy one.`,
      taskType: 'implementation',
      project: project.id,
      symbols: [symbol],
      expectedSelectedSandboxIds: [pair.current.sandboxId],
      forbiddenSandboxIds: [pair.stale.sandboxId],
      expectedItemTypes: ['workflow', 'memory'],
      expectedNoiseFilteredSandboxIds: [pair.stale.sandboxId],
      groundingFacts: [
        { description: `current ${symbol} workflow`, weight: 0.6, terms: [symbol, 'current'] },
        { description: `not the legacy version`, weight: 0.4, terms: ['current'] },
      ],
    });
  }

  // Duplicate dedup prompt — only the canonical should be selected
  if (duplicatePairs.length > 0) {
    const pair = duplicatePairs[0];
    const symbol = findLabel(pair.canonical, 'symbol') ?? project.symbols[0];
    out.push({
      id: `${project.id}-canon-${pair.canonical.sandboxId}`,
      prompt: `Review whether ${symbol} guardrails are documented in ${project.id}. Avoid near-duplicate notes.`,
      taskType: 'review',
      project: project.id,
      symbols: [symbol],
      expectedSelectedSandboxIds: [pair.canonical.sandboxId],
      forbiddenSandboxIds: [pair.duplicate.sandboxId],
      expectedNoiseFilteredSandboxIds: [pair.duplicate.sandboxId],
      groundingFacts: [
        { description: `${symbol} guardrails`, weight: 0.6, terms: [symbol, 'guardrails'] },
      ],
    });
  }

  // Safety prompt — adversarial content must NOT be selected
  if (adversarial.length > 0 && goldByProject.length > 0) {
    const adv = adversarial[0];
    const symbol = findLabel(adv, 'symbol') ?? project.symbols[0];
    out.push({
      id: `${project.id}-safety-${adv.sandboxId}`,
      prompt: `Investigate ${symbol} notes in ${project.id}. Surface only safe, trustworthy memories.`,
      taskType: 'exploration',
      project: project.id,
      symbols: [symbol],
      expectedSelectedSandboxIds: [],
      forbiddenSandboxIds: [adv.sandboxId],
      expectedNoiseFilteredSandboxIds: [adv.sandboxId],
      groundingFacts: [
        { description: `safety-first surfacing`, weight: 1, terms: [symbol] },
      ],
    });
  }

  // Testing prompt — explicit task type
  const testingGold = goldByProject.find((item) => item.itemType === 'workflow') ?? goldByProject.find((item) => item.itemType === 'code_ref');
  if (testingGold) {
    const symbol = findLabel(testingGold, 'symbol') ?? project.symbols[0];
    const file = findLabel(testingGold, 'file') ?? project.files[0];
    out.push({
      id: `${project.id}-test-${symbol}`,
      prompt: `Write integration tests for ${symbol} in ${file}. What verification commands and prior workflows apply?`,
      taskType: 'testing',
      project: project.id,
      files: [file],
      symbols: [symbol],
      expectedSelectedSandboxIds: [testingGold.sandboxId],
      forbiddenSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
      expectedItemTypes: ['workflow', 'rule', 'bugfix', 'code_ref'],
      expectedNoiseFilteredSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
      groundingFacts: [
        { description: `tests ${symbol}`, weight: 0.5, terms: [symbol, 'test'] },
        { description: `references ${file}`, weight: 0.5, terms: [file] },
      ],
    });
  }

  // Exploration prompt — wiki/code_ref discovery
  out.push({
    id: `${project.id}-explore`,
    prompt: `Explore the ${project.domain} architecture in ${project.id}. What components and references are documented?`,
    taskType: 'exploration',
    project: project.id,
    expectedSelectedSandboxIds: goldByProject.slice(0, 2).map((item) => item.sandboxId),
    forbiddenSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
    expectedItemTypes: ['wiki', 'code_ref', 'memory', 'workflow'],
    expectedNoiseFilteredSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
    groundingFacts: [
      { description: `covers ${project.domain}`, weight: 0.5, terms: [project.domain] },
      { description: `project ${project.id}`, weight: 0.5, terms: [project.id] },
    ],
  });

  // Refactor prompt
  const refactorGold = goldByProject.find((item) => item.itemType === 'code_ref' || item.itemType === 'rule');
  if (refactorGold) {
    const symbol = findLabel(refactorGold, 'symbol') ?? project.symbols[0];
    const file = findLabel(refactorGold, 'file') ?? project.files[0];
    out.push({
      id: `${project.id}-refactor-${symbol}`,
      prompt: `Refactor ${symbol} in ${file} without breaking the ${project.domain} flow. What rules and references apply?`,
      taskType: 'refactor',
      project: project.id,
      files: [file],
      symbols: [symbol],
      expectedSelectedSandboxIds: [refactorGold.sandboxId],
      forbiddenSandboxIds: [],
      expectedItemTypes: ['code_ref', 'rule', 'workflow'],
      expectedNoiseFilteredSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
      groundingFacts: [
        { description: `refactor ${symbol}`, weight: 0.5, terms: [symbol] },
        { description: `${project.domain} guarantees`, weight: 0.5, terms: [project.domain] },
      ],
    });
  }

  // Review prompt
  if (goldByProject.length > 0) {
    const reviewGold = goldByProject[Math.min(2, goldByProject.length - 1)];
    out.push({
      id: `${project.id}-review-${reviewGold.sandboxId}`,
      prompt: `Review the latest ${project.domain} changes in ${project.id}. Use prior approved memories and rules.`,
      taskType: 'review',
      project: project.id,
      expectedSelectedSandboxIds: [reviewGold.sandboxId],
      forbiddenSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
      expectedItemTypes: ['rule', 'spec', 'code_ref', 'memory'],
      expectedNoiseFilteredSandboxIds: noise.slice(0, 2).map((item) => item.sandboxId),
      groundingFacts: [
        { description: `${project.domain} review`, weight: 0.5, terms: [project.domain] },
        { description: `prior memory`, weight: 0.5, terms: ['memory'] },
      ],
    });
  }

  return out;
}

function buildCrossProjectPrompts(fixture: SandboxFixture): SandboxPrompt[] {
  const out: SandboxPrompt[] = [];

  // Off-domain suppression: prompt mentions one project, noise comes from another
  for (const project of fixture.projects) {
    const noise = fixture.knowledge.find((item) => item.tier === 'B' && item.project === project.id);
    const gold = fixture.knowledge.find((item) => item.tier === 'A' && item.project === project.id);
    if (noise && gold) {
      const symbol = findLabel(gold, 'symbol') ?? project.symbols[0];
      out.push({
        id: `${project.id}-offdomain-${noise.sandboxId}`,
        prompt: `Confirm ${symbol} ownership in ${project.id}. Ignore notes from unrelated domains.`,
        taskType: 'exploration',
        project: project.id,
        symbols: [symbol],
        expectedSelectedSandboxIds: [gold.sandboxId],
        forbiddenSandboxIds: [noise.sandboxId],
        expectedNoiseFilteredSandboxIds: [noise.sandboxId],
        groundingFacts: [
          { description: `${symbol} ownership`, weight: 0.7, terms: [symbol] },
          { description: `same project`, weight: 0.3, terms: [project.id] },
        ],
      });
    }
  }

  return out;
}

function findLabel(knowledge: SandboxKnowledge, type: LabelType): string | undefined {
  return knowledge.labels?.find((label) => label.type === type)?.value;
}

interface StalePair {
  stale: SandboxKnowledge;
  current: SandboxKnowledge;
}

function collectStalePairs(projectId: string, fixture: SandboxFixture): StalePair[] {
  const stales = fixture.knowledge.filter((item) => item.tier === 'C' && item.project === projectId && item.sandboxId.includes('-stale-'));
  const currents = fixture.knowledge.filter((item) => item.tier === 'C' && item.project === projectId && item.sandboxId.includes('-current-'));
  const pairs: StalePair[] = [];
  for (const stale of stales) {
    const suffix = stale.sandboxId.replace(/^[^-]+-stale-/, '');
    const current = currents.find((item) => item.sandboxId.endsWith(`-current-${suffix}`));
    if (current) {
      pairs.push({ stale, current });
    }
  }
  return pairs;
}

interface DuplicatePair {
  canonical: SandboxKnowledge;
  duplicate: SandboxKnowledge;
}

function collectDuplicatePairs(projectId: string, fixture: SandboxFixture): DuplicatePair[] {
  const canonicals = fixture.knowledge.filter((item) => item.tier === 'D' && item.project === projectId && item.sandboxId.includes('-canon-'));
  const duplicates = fixture.knowledge.filter((item) => item.tier === 'D' && item.project === projectId && item.sandboxId.includes('-dup-'));
  const pairs: DuplicatePair[] = [];
  for (const canonical of canonicals) {
    const suffix = canonical.sandboxId.replace(/^[^-]+-canon-/, '');
    const duplicate = duplicates.find((item) => item.sandboxId.endsWith(`-dup-${suffix}`));
    if (duplicate) {
      pairs.push({ canonical, duplicate });
    }
  }
  return pairs;
}
