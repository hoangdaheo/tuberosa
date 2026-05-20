import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CandidateSource, KnowledgeItemType } from '../types.js';

export interface FreshnessWindow {
  /** Days <= currentDays counts as "current" (small positive nudge). */
  currentDays: number;
  /** Days > staleDays counts as stale (full penalty). */
  staleDays: number;
  /** Optional explicit penalty to apply when stale. Defaults to global -0.12. */
  stalePenalty?: number;
}

export interface RetrievalPolicy {
  useFreshnessMap: boolean;
  freshnessGlobal: FreshnessWindow;
  freshnessPolicy: Partial<Record<KnowledgeItemType, FreshnessWindow>>;

  sourceWeights: Record<CandidateSource, number>;
  hardSignalBoost: { sources: CandidateSource[]; bonus: number };
  hardSignalVectorPenalty: number;
  taskItemTypeBoosts: Array<{ taskType: string; itemTypes: KnowledgeItemType[]; bonus: number }>;

  duplicateDetector: 'off' | 'on';
  duplicateJaccardThreshold: number;
  duplicateCosineThreshold: number;

  piiRedaction: { emails: boolean; phones: boolean; ipv4: boolean };

  domainMismatch: { enabled: boolean; mismatchPenalty: number; matchBoost: number };

  suppressionEnabled: {
    stale: boolean;
    domainMismatch: boolean;
    feedback: boolean;
    superseded: boolean;
    evidenceMismatch: boolean;
  };
}

export const DEFAULT_POLICY: RetrievalPolicy = {
  useFreshnessMap: true,
  freshnessGlobal: { currentDays: 180, staleDays: 365, stalePenalty: -0.12 },
  freshnessPolicy: {
    spec: { currentDays: 540, staleDays: 1460, stalePenalty: -0.05 },
    rule: { currentDays: 540, staleDays: 1460, stalePenalty: -0.05 },
    code_ref: { currentDays: 270, staleDays: 720, stalePenalty: -0.08 },
    bugfix: { currentDays: 240, staleDays: 540, stalePenalty: -0.1 },
    workflow: { currentDays: 180, staleDays: 420, stalePenalty: -0.12 },
    wiki: { currentDays: 270, staleDays: 720, stalePenalty: -0.08 },
    memory: { currentDays: 120, staleDays: 300, stalePenalty: -0.14 },
    conversation: { currentDays: 60, staleDays: 180, stalePenalty: -0.16 },
  },

  sourceWeights: {
    metadata: 1.15,
    reference: 1.12,
    graph: 1.1,
    memory: 1.08,
    lexical: 1.0,
    vector: 0.92,
  },
  hardSignalBoost: { sources: ['metadata', 'lexical', 'graph'], bonus: 0.18 },
  hardSignalVectorPenalty: -0.08,
  taskItemTypeBoosts: [
    { taskType: 'debugging', itemTypes: ['bugfix', 'memory', 'workflow'], bonus: 0.16 },
    { taskType: 'planning', itemTypes: ['spec', 'wiki', 'workflow'], bonus: 0.12 },
  ],

  duplicateDetector: 'on',
  duplicateJaccardThreshold: 0.85,
  duplicateCosineThreshold: 0.92,

  piiRedaction: { emails: false, phones: false, ipv4: false },

  domainMismatch: { enabled: true, mismatchPenalty: -0.3, matchBoost: 0.15 },

  suppressionEnabled: {
    stale: true,
    domainMismatch: true,
    feedback: true,
    superseded: true,
    evidenceMismatch: true,
  },
};

let cachedPolicy: RetrievalPolicy | null = null;
let cachedPath: string | null = null;

export function getRetrievalPolicy(): RetrievalPolicy {
  if (cachedPolicy) {
    return cachedPolicy;
  }
  cachedPolicy = loadRetrievalPolicy();
  return cachedPolicy;
}

export function resetRetrievalPolicyCache(): void {
  cachedPolicy = null;
  cachedPath = null;
}

export function setRetrievalPolicy(policy: RetrievalPolicy): void {
  cachedPolicy = policy;
}

export function loadRetrievalPolicy(): RetrievalPolicy {
  const path = process.env.TUBEROSA_RETRIEVAL_POLICY ?? resolve(process.cwd(), 'config/retrieval-policy.json');
  cachedPath = path;
  if (!existsSync(path)) {
    return DEFAULT_POLICY;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RetrievalPolicy>;
    return mergePolicy(DEFAULT_POLICY, parsed);
  } catch {
    return DEFAULT_POLICY;
  }
}

export function getRetrievalPolicyPath(): string | null {
  return cachedPath;
}

function mergePolicy(base: RetrievalPolicy, override: Partial<RetrievalPolicy>): RetrievalPolicy {
  return {
    ...base,
    ...override,
    freshnessGlobal: { ...base.freshnessGlobal, ...(override.freshnessGlobal ?? {}) },
    freshnessPolicy: { ...base.freshnessPolicy, ...(override.freshnessPolicy ?? {}) },
    sourceWeights: { ...base.sourceWeights, ...(override.sourceWeights ?? {}) },
    hardSignalBoost: { ...base.hardSignalBoost, ...(override.hardSignalBoost ?? {}) },
    taskItemTypeBoosts: override.taskItemTypeBoosts ?? base.taskItemTypeBoosts,
    piiRedaction: { ...base.piiRedaction, ...(override.piiRedaction ?? {}) },
    domainMismatch: { ...base.domainMismatch, ...(override.domainMismatch ?? {}) },
    suppressionEnabled: { ...base.suppressionEnabled, ...(override.suppressionEnabled ?? {}) },
  };
}

export function freshnessWindowFor(policy: RetrievalPolicy, itemType: KnowledgeItemType): FreshnessWindow {
  if (!policy.useFreshnessMap) {
    return policy.freshnessGlobal;
  }
  return policy.freshnessPolicy[itemType] ?? policy.freshnessGlobal;
}
