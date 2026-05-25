import type {
  KnowledgeItemType,
  LabelInput,
  ReferenceInput,
  TriggerType,
} from './knowledge.js';
import type {
  ContextPack,
  ContextSearchInput,
  RankedCandidate,
} from './retrieval.js';
import type { FeedbackEvent, FeedbackInput, FeedbackType } from './feedback.js';

export interface ReflectionDraftInput {
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType?: KnowledgeItemType;
  triggerType: TriggerType;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  metadata?: Record<string, unknown>;
}

export type ReflectionDraftStatus = 'pending' | 'approved' | 'rejected' | 'needs_changes';

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
  duplicateCandidates: RankedCandidate[];
  createdAt: string;
}

export interface ReflectionDraftPatchInput {
  status?: ReflectionDraft['status'];
  metadata?: Record<string, unknown>;
  suggestedLabels?: LabelInput[];
  references?: ReferenceInput[];
}

export type ReflectionDraftReviewDecision = 'approve' | 'reject' | 'needs_changes';

export type ReflectionDraftReviewGrade = 'pass' | 'concern' | 'fail';

export type ReflectionDraftDuplicateRisk = 'low' | 'medium' | 'high';

export interface ReflectionDraftReviewEvaluation {
  accuracy?: ReflectionDraftReviewGrade;
  usefulness?: ReflectionDraftReviewGrade;
  scope?: ReflectionDraftReviewGrade;
  privacySafety?: ReflectionDraftReviewGrade;
  labels?: ReflectionDraftReviewGrade;
  references?: ReflectionDraftReviewGrade;
  duplicateRisk?: ReflectionDraftDuplicateRisk;
}

export interface ReflectionDraftReviewInput {
  id: string;
  decision: ReflectionDraftReviewDecision;
  reviewer?: string;
  reviewerNote?: string;
  evaluation?: ReflectionDraftReviewEvaluation;
  metadata?: Record<string, unknown>;
}

export type AgentSessionStatus = 'active' | 'finished';

export type AgentSessionOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled';

export type AgentContextDecisionType = FeedbackInput['feedbackType'];

export type AgentLearningMode = 'auto' | 'draft_only' | 'off';

export type AgentLearningSignalKind =
  | 'tip'
  | 'decision'
  | 'mistake'
  | 'verification'
  | 'file_change'
  | 'user_preference'
  | 'follow_up';

export type AgentLearningSignalSource =
  | 'user'
  | 'agent'
  | 'tool'
  | 'system'
  | 'reviewer';

export interface AgentLearningSignal {
  kind: AgentLearningSignalKind;
  text: string;
  source?: AgentLearningSignalSource;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  references?: ReferenceInput[];
  confidence?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ResearchTraceReference {
  file?: string;
  symbol?: string;
  command?: string;
  knowledgeId?: string;
}

export interface ResearchTraceStep {
  kind: 'thought' | 'action' | 'observation' | 'decision';
  text: string;
  references?: ResearchTraceReference[];
}

export interface ResearchTraceInput {
  steps: ResearchTraceStep[];
  outcome: string;
}

export interface ResearchTraceSummary extends ResearchTraceInput {
  derived: boolean;
  bytes: number;
}

export interface CaptureAgentLearningSignalInput extends AgentLearningSignal {
  sessionId: string;
  author?: string;
  contextPackId?: string;
}

export type AgentLearningDecisionStatus =
  | 'skipped'
  | 'drafted'
  | 'auto_approved'
  | 'rejected';

export interface AgentSessionLearningDecision {
  mode: AgentLearningMode;
  status: AgentLearningDecisionStatus;
  reasons: string[];
  draftId?: string;
}

export interface AgentSessionNote {
  at: string;
  note: string;
  author?: string;
  feedbackType?: FeedbackType;
  feedbackId?: string;
  contextPackId?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendAgentSessionNoteInput {
  sessionId: string;
  note: string;
  author?: string;
  feedbackType?: FeedbackType;
  contextPackId?: string;
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AppendAgentSessionNoteResult {
  session: AgentSession;
  note: AgentSessionNote;
  feedback?: FeedbackEvent;
}

export interface CaptureAgentLearningSignalResult extends AppendAgentSessionNoteResult {
  signal: AgentLearningSignal;
}

export interface AgentSession {
  id: string;
  project?: string;
  cwd?: string;
  prompt: string;
  agentName?: string;
  agentTool?: string;
  status: AgentSessionStatus;
  initialContextPackId?: string;
  outcome?: AgentSessionOutcome;
  summary?: string;
  reflectionDraftIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface AgentContextDecision {
  id: string;
  sessionId: string;
  contextPackId?: string;
  decision: AgentContextDecisionType;
  reason?: string;
  rejectedKnowledgeIds: string[];
  retryContextPackId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface StartAgentSessionInput extends ContextSearchInput {
  agentName?: string;
  agentTool?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordAgentContextDecisionInput {
  sessionId: string;
  contextPackId?: string;
  feedbackType: AgentContextDecisionType;
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface FinishAgentSessionInput {
  sessionId: string;
  outcome: AgentSessionOutcome;
  summary?: string;
  agentOutputSummary?: string;
  changedFiles?: string[];
  verificationCommands?: string[];
  learningSignals?: AgentLearningSignal[];
  contextBypassReason?: string;
  learningMode?: AgentLearningMode;
  metadata?: Record<string, unknown>;
  researchTrace?: ResearchTraceInput;
  reflectionDraft?: ReflectionDraftInput;
}

export type AgentContextComplianceStatus =
  | 'compliant'
  | 'needs_decision'
  | 'missing_context_recorded'
  | 'bypassed'
  | 'non_compliant';

export interface AgentContextCompliance {
  status: AgentContextComplianceStatus;
  checkedAt: string;
  instruction: string;
  decisionIds: string[];
  contextPackId?: string;
  bypassReason?: string;
}

export interface AgentSessionStartResult {
  session: AgentSession;
  contextPack: ContextPack;
  policy: AgentSessionPolicy;
}

export interface AgentSessionDecisionResult {
  session: AgentSession;
  decision: AgentContextDecision;
  retry?: ContextPack;
  policy?: AgentSessionPolicy;
}

export interface AgentSessionFinishResult {
  session: AgentSession;
  reflectionDraft?: ReflectionDraft;
  learningCandidate?: ReflectionDraft;
  autoApprovedMemory?: ReflectionDraft;
  learningDecision?: AgentSessionLearningDecision;
  compliance: AgentContextCompliance;
}

export interface AgentSessionPolicy {
  action: 'proceed' | 'confirm' | 'clarify';
  instruction: string;
}
