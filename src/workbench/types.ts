// Workbench-local mirror types. These mirror the backend API response shapes,
// kept in this file so the bundler does not pull node-only modules into the browser.

export type RecommendationVerdict = 'approve' | 'needs_changes' | 'reject';
export type RecommendationConfidence = 'high' | 'medium' | 'low';
export type GateKey =
  | 'learning_mode' | 'session_outcome' | 'compliance' | 'context_fit'
  | 'negative_decisions' | 'noisy_feedback' | 'signal_confidence' | 'duplicates'
  | 'grounded_references' | 'concrete_labels' | 'draft_maturity';

export type GateStatus = 'pass' | 'fail' | 'unknown';
export type GateSeverity = 'soft' | 'hard';

export interface GateResult {
  key: GateKey;
  status: GateStatus;
  severity: GateSeverity;
  label: string;
  message: string;
  detail?: string;
}

export interface RecommendationPoint { key: GateKey; label: string; detail: string }

export interface DraftRecommendation {
  draftId: string;
  verdict: RecommendationVerdict;
  confidence: RecommendationConfidence;
  oneLineRationale: string;
  pros: RecommendationPoint[];
  cons: RecommendationPoint[];
  blockers: RecommendationPoint[];
  unknowns: RecommendationPoint[];
  gates: GateResult[];
  canAutoApprove: boolean;
}

export type ReflectionDraftStatus = 'pending' | 'approved' | 'rejected' | 'needs_changes';
export type KnowledgeItemType = 'spec' | 'workflow' | 'memory' | 'bugfix' | 'code_ref' | 'rule' | 'wiki' | 'conversation';
export type TriggerType =
  | 'complex_task_success'
  | 'error_recovery'
  | 'user_correction'
  | 'non_trivial_workflow'
  | 'manual';

export interface LabelInput { type: string; value: string; weight?: number }
export interface ReferenceInput { type: string; uri: string; lineStart?: number; lineEnd?: number }

export interface ReflectionDraft {
  id: string;
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType: KnowledgeItemType;
  triggerType: TriggerType;
  status: ReflectionDraftStatus;
  suggestedLabels: LabelInput[];
  references: ReferenceInput[];
  metadata: Record<string, unknown>;
  duplicateCandidates: Array<{ knowledgeId: string; title: string; score: number }>;
  createdAt: string;
}

export interface ContextFit {
  fitStatus: 'ready' | 'needs_confirmation' | 'insufficient';
  fitScore: number;
  fitReasons: string[];
  missingSignals: string[];
}

export interface ContextPackOrientation {
  inferredTask: string;
  recommendedFiles: Array<{ path: string; reason: string }>;
  likelySurfaces: string[];
  verificationCommands: string[];
  missingSignals: { files: string[]; symbols: string[]; errors: string[]; docs: string[]; intent: string[]; other: string[] };
  notes: string[];
}

export interface ContextPackActionItem {
  priority: number;
  action: string;
  label: string;
  targetKind?: string;
  targetTitle?: string;
  reason?: string;
  command?: string;
  targetPath?: string;
}

export interface ContextPackTaskBrief {
  goal: string;
  actionItems: ContextPackActionItem[];
  directEvidenceKnowledgeIds: string[];
  adjacentKnowledgeIds: string[];
}

export interface RankedCandidate {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: KnowledgeItemType;
  finalScore: number;
  matchReasons: string[];
  evidenceCategory?: 'directTaskEvidence' | 'priorLessons' | 'workflowGuidance' | 'adjacentContext';
  evidenceStrength?: 'strong' | 'moderate' | 'weak';
  usefulnessReason?: string;
  references?: ReferenceInput[];
}

export interface ContextPackSection {
  name: 'essential' | 'supporting' | 'optional';
  items: RankedCandidate[];
  tokenEstimate: number;
}

export interface ContextPack {
  id: string;
  prompt: string;
  status: 'proposed' | 'selected' | 'rejected';
  confidence: number;
  contextFit?: ContextFit;
  orientation?: ContextPackOrientation;
  taskBrief?: ContextPackTaskBrief;
  sections: ContextPackSection[];
}

export interface AgentSession {
  id: string;
  project?: string;
  status: 'active' | 'finished';
  prompt: string;
  outcome?: 'completed' | 'failed' | 'blocked' | 'cancelled';
  reflectionDraftIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentSessionStartResult {
  session: AgentSession;
  contextPack: ContextPack;
  policy: { action: 'proceed' | 'confirm' | 'clarify'; instruction: string };
}

export interface ContextDecisionResult {
  session: AgentSession;
  decision: { id: string; decision: string; reason?: string };
  retry?: ContextPack;
}

export interface FinishSessionResult {
  session: AgentSession;
  reflectionDraft?: ReflectionDraft;
  learningCandidate?: ReflectionDraft;
  autoApprovedMemory?: ReflectionDraft;
  learningDecision?: { status: string; reasons: string[]; draftId?: string };
  compliance: { status: string; instruction: string };
}

export interface KnowledgeItem {
  id: string;
  project: string;
  title: string;
  summary: string;
  content: string;
  itemType: KnowledgeItemType;
  status: string;
  trustLevel: number;
  labels: LabelInput[];
  references: ReferenceInput[];
  freshnessAt?: string;
  updatedAt?: string;
  createdAt: string;
}

export interface WorkbenchCounts {
  recentSessions?: number;
  activeSessions?: number;
  pendingDrafts?: number;
  contextQualityRecords?: number;
  contextQualityMatched?: number;
  openGaps?: number;
  openProposals?: number;
  openConflicts?: number;
  autoMemories?: number;
  riskyAutoMemories?: number;
  openErrorLogs?: number;
  backupCount?: number;
}

export interface WorkbenchSummary {
  generatedAt: string;
  filters: { project?: string; limit: number };
  health: {
    ok: boolean;
    store: string;
    durability: string;
    cache: string;
    modelProvider: string;
    backupStatus?: { latestBackup?: { createdAt: string; ageSeconds: number }; health?: string };
  };
  counts: WorkbenchCounts;
  countMetadata?: { capped?: Partial<Record<keyof WorkbenchCounts, boolean>> };
  recentSessions: Array<{ id: string; prompt: string; status: string; outcome?: string; createdAt: string }>;
  contextQuality: {
    records: Array<{
      id: string;
      feedbackType: string;
      reason?: string;
      contextPackId?: string;
      createdAt: string;
      knowledgeIds?: string[];
    }>;
    totalMatched: number;
    filters: { limit: number };
  };
  pendingDrafts: Array<Partial<ReflectionDraft> & { id: string; title: string; summary: string }>;
  openGaps: Array<{ id: string; topic?: string; prompt?: string; project?: string; missingSignals?: Record<string, string[]> | string[]; createdAt: string }>;
  openProposals: Array<{ id: string; proposalType: string; title?: string; reason?: string; createdAt: string }>;
  openConflicts: Array<{ id: string; status: string; reason: string; createdAt: string }>;
  riskyAutoMemories: Array<{ id: string; title: string; reasons?: string[]; review?: string }>;
  openErrorLogs: {
    records: Array<{ id: string; category: string; severity: string; status: string; title: string; lastSeenAt: string; occurrenceCount: number }>;
    totalMatched: number;
  };
  recommendedActions: Array<{ priority: number; target: string; label: string; count: number; href?: string; reason?: string }>;
}
