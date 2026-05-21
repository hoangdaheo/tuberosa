import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CandidateSource, KnowledgeItemType, KnowledgeRelationType, TaskType } from '../types.js';
import { sha256, stableJson } from '../util/hash.js';

export interface FreshnessWindow {
  /** Days <= currentDays counts as "current" (small positive nudge). */
  currentDays: number;
  /** Days > staleDays counts as stale (full penalty). */
  staleDays: number;
  /** Optional explicit penalty to apply when stale. Defaults to global -0.12. */
  stalePenalty?: number;
}

export interface TaskFusionProfile {
  /** Multiplicative deltas applied on top of the global sourceWeights for this task. */
  sourceWeights?: Partial<Record<CandidateSource, number>>;
  /** Extra task-specific itemType boosts merged with the global taskItemTypeBoosts. */
  itemTypeBoosts?: Array<{ itemTypes: KnowledgeItemType[]; bonus: number }>;
}

export interface CoverageProfile {
  file?: number;
  symbol?: number;
  error?: number;
  technology?: number;
  businessArea?: number;
}

export interface GraphHopWeights {
  /** Multiplier on relation.confidence when a candidate matches a classified hard signal directly. */
  target: number;
  /** Multiplier on relation.confidence when a candidate is reached from a seed (one hop). */
  seed: number;
  /** Multiplier on relation.confidence for an additional depth-2 hop. Only used when graphMaxHops>=2. */
  depth2?: number;
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

  /** Phase 3 — when true, ingestion expands ontology-aware labels to include their ancestors. */
  useOntology: boolean;

  /** Phase 3 — when true, IngestionService runs the content-aware itemType inference. */
  useItemTypeInference: boolean;

  /** Phase 3 — when true, IngestionService runs the AST-based code-label extractor for supported sources. */
  useAstExtractor: boolean;

  /** Phase 4 — when true, fusion.ts applies the per-task profile on top of the global weights. */
  useTaskProfiles: boolean;
  /** Phase 4 — table-driven per-task fusion adjustments. Empty / missing entries fall back to globals. */
  taskProfiles: Partial<Record<TaskType, TaskFusionProfile>>;

  /** Phase 4 — when true, context-fit aggregates use per-task coverage weights. */
  useCoverageProfiles: boolean;
  /** Phase 4 — fallback signal weights when no per-task override is provided. */
  coverageGlobal: Required<CoverageProfile>;
  /** Phase 4 — per-task signal weights for the context-fit aggregator. */
  coverageProfiles: Partial<Record<TaskType, CoverageProfile>>;

  /** Phase 4 — graph hop scoring knobs. Replaces the literal 0.95/0.68 multipliers. */
  graphHopWeights: GraphHopWeights;
  /** Phase 4 — extra multiplier per relation kind, applied after graphHopWeights. */
  relationKindMultipliers: Partial<Record<KnowledgeRelationType, number>>;
  /** Phase 4 — max graph hops (1 = current behaviour; 2 = enable depth-2 expansion). */
  graphMaxHops: 1 | 2;

  /**
   * Phase 4 — optional metadata from `scripts/calibrate-fusion.ts`. Not consumed by retrieval directly,
   * but checked in to make the file self-describing for reviewers.
   */
  calibration?: {
    calibratedAt?: string;
    seed?: number;
    notes?: string;
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

  useOntology: true,
  useItemTypeInference: true,
  useAstExtractor: true,

  useTaskProfiles: true,
  taskProfiles: {
    debugging: {
      sourceWeights: { metadata: 0.06, graph: 0.05, memory: 0.03, vector: -0.04 },
      itemTypeBoosts: [{ itemTypes: ['bugfix', 'memory'], bonus: 0.04 }],
    },
    implementation: {
      sourceWeights: { metadata: 0.04, lexical: 0.03, vector: -0.02 },
      itemTypeBoosts: [{ itemTypes: ['code_ref', 'spec'], bonus: 0.03 }],
    },
    refactor: {
      sourceWeights: { metadata: 0.04, lexical: 0.03 },
      itemTypeBoosts: [{ itemTypes: ['code_ref', 'rule'], bonus: 0.03 }],
    },
    review: {
      sourceWeights: { metadata: 0.04, memory: 0.02 },
      itemTypeBoosts: [{ itemTypes: ['rule', 'memory'], bonus: 0.03 }],
    },
    planning: {
      sourceWeights: { vector: 0.03, lexical: 0.02, metadata: 0.02 },
      itemTypeBoosts: [{ itemTypes: ['spec', 'wiki'], bonus: 0.04 }],
    },
    exploration: {
      sourceWeights: { vector: 0.04, lexical: 0.03 },
      itemTypeBoosts: [{ itemTypes: ['wiki', 'workflow'], bonus: 0.02 }],
    },
    testing: {
      sourceWeights: { metadata: 0.05, lexical: 0.03 },
      itemTypeBoosts: [{ itemTypes: ['workflow', 'bugfix'], bonus: 0.03 }],
    },
    unknown: {},
  },

  useCoverageProfiles: true,
  coverageGlobal: { file: 0.24, symbol: 0.22, error: 0.22, technology: 0.12, businessArea: 0.12 },
  coverageProfiles: {
    debugging: { file: 0.2, symbol: 0.2, error: 0.3, technology: 0.1, businessArea: 0.08 },
    implementation: { file: 0.26, symbol: 0.24, error: 0.16, technology: 0.14, businessArea: 0.1 },
    refactor: { file: 0.22, symbol: 0.3, error: 0.14, technology: 0.14, businessArea: 0.1 },
    review: { file: 0.22, symbol: 0.22, error: 0.2, technology: 0.12, businessArea: 0.14 },
    planning: { file: 0.18, symbol: 0.16, error: 0.12, technology: 0.18, businessArea: 0.22 },
    exploration: { file: 0.2, symbol: 0.18, error: 0.14, technology: 0.18, businessArea: 0.18 },
    testing: { file: 0.24, symbol: 0.22, error: 0.24, technology: 0.12, businessArea: 0.1 },
    unknown: { file: 0.24, symbol: 0.22, error: 0.22, technology: 0.12, businessArea: 0.12 },
  },

  graphHopWeights: { target: 0.95, seed: 0.68, depth2: 0.42 },
  relationKindMultipliers: {
    supersedes: 1.1,
    resolves_error: 1.05,
    depends_on: 1.02,
    references: 1.0,
    mentions_symbol: 1.0,
    mentions_file: 0.95,
    contains: 0.95,
    related_to: 0.9,
    derived_from_session: 0.9,
  },
  graphMaxHops: 1,
};

let cachedPolicy: RetrievalPolicy | null = null;
let cachedPath: string | null = null;
let cachedPolicyFingerprint: string | null = null;

export function getRetrievalPolicy(): RetrievalPolicy {
  if (cachedPolicy) {
    return cachedPolicy;
  }
  cachedPolicy = loadRetrievalPolicy();
  return cachedPolicy;
}

export function getRetrievalPolicyFingerprint(): string {
  if (cachedPolicyFingerprint) {
    return cachedPolicyFingerprint;
  }
  cachedPolicyFingerprint = sha256(stableJson(getRetrievalPolicy()));
  return cachedPolicyFingerprint;
}

/** @internal Test/admin only. Used by tests and `scripts/calibrate-fusion.ts` to force a reload. */
export function resetRetrievalPolicyCache(): void {
  cachedPolicy = null;
  cachedPath = null;
  cachedPolicyFingerprint = null;
}

/** @internal Test/admin only. Used by tests to inject a synthetic policy without touching the file. */
export function setRetrievalPolicy(policy: RetrievalPolicy): void {
  cachedPolicy = policy;
  cachedPolicyFingerprint = null;
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
    taskProfiles: { ...base.taskProfiles, ...(override.taskProfiles ?? {}) },
    coverageGlobal: { ...base.coverageGlobal, ...(override.coverageGlobal ?? {}) },
    coverageProfiles: { ...base.coverageProfiles, ...(override.coverageProfiles ?? {}) },
    graphHopWeights: { ...base.graphHopWeights, ...(override.graphHopWeights ?? {}) },
    relationKindMultipliers: { ...base.relationKindMultipliers, ...(override.relationKindMultipliers ?? {}) },
    calibration: override.calibration ?? base.calibration,
  };
}

export function freshnessWindowFor(policy: RetrievalPolicy, itemType: KnowledgeItemType): FreshnessWindow {
  if (!policy.useFreshnessMap) {
    return policy.freshnessGlobal;
  }
  return policy.freshnessPolicy[itemType] ?? policy.freshnessGlobal;
}

/** Phase 4 — return the (possibly task-adjusted) base weight for a candidate source. */
export function effectiveSourceWeight(policy: RetrievalPolicy, source: CandidateSource, taskType: TaskType): number {
  const base = policy.sourceWeights[source] ?? 1;
  if (!policy.useTaskProfiles) return base;
  const profile = policy.taskProfiles[taskType];
  const delta = profile?.sourceWeights?.[source] ?? 0;
  return base + delta;
}

/** Phase 4 — return the per-task itemType bonuses, merged with the global task→itemType list. */
export function effectiveTaskItemTypeBoosts(
  policy: RetrievalPolicy,
  taskType: TaskType,
): Array<{ taskType: string; itemTypes: KnowledgeItemType[]; bonus: number }> {
  const base = policy.taskItemTypeBoosts;
  if (!policy.useTaskProfiles) return base;
  const profile = policy.taskProfiles[taskType];
  if (!profile?.itemTypeBoosts || profile.itemTypeBoosts.length === 0) return base;
  const extras = profile.itemTypeBoosts.map((entry) => ({
    taskType: taskType as string,
    itemTypes: entry.itemTypes,
    bonus: entry.bonus,
  }));
  return [...base, ...extras];
}

/** Phase 4 — return the per-task coverage profile, defaulting to coverageGlobal. */
export function coverageProfileFor(policy: RetrievalPolicy, taskType: TaskType): Required<CoverageProfile> {
  if (!policy.useCoverageProfiles) return policy.coverageGlobal;
  const override = policy.coverageProfiles[taskType];
  if (!override) return policy.coverageGlobal;
  return {
    file: override.file ?? policy.coverageGlobal.file,
    symbol: override.symbol ?? policy.coverageGlobal.symbol,
    error: override.error ?? policy.coverageGlobal.error,
    technology: override.technology ?? policy.coverageGlobal.technology,
    businessArea: override.businessArea ?? policy.coverageGlobal.businessArea,
  };
}

/** Phase 4 — composite graph-hop multiplier for a single relation traversal. */
export function graphHopMultiplier(
  policy: RetrievalPolicy,
  role: 'target' | 'seed' | 'depth2',
  relationType: KnowledgeRelationType,
): number {
  const base = role === 'depth2'
    ? (policy.graphHopWeights.depth2 ?? policy.graphHopWeights.seed * 0.6)
    : policy.graphHopWeights[role];
  const relationMultiplier = policy.relationKindMultipliers[relationType] ?? 1;
  return base * relationMultiplier;
}
