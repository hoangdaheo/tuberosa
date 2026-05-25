import type {
  ContextEvidenceCategory,
  ContextEvidenceStrength,
  ContextFitStatus,
  ContextPack,
} from './retrieval.js';
import type {
  LearningProposalType,
  LearningReviewStatus,
} from './operations.js';
import type {
  AgentSessionOutcome,
  AgentSessionStatus,
} from './session.js';

export type FeedbackQualityType =
  | 'selected_but_noisy'
  | 'too_much_adjacent_context'
  | 'missing_orientation'
  | 'missing_current_handoff'
  | 'missing_verification_commands';

export type FeedbackType =
  | 'selected'
  | 'rejected'
  | 'irrelevant'
  | 'stale'
  | 'missing_context'
  | FeedbackQualityType;

export interface FeedbackInput {
  contextPackId?: string;
  project?: string;
  feedbackType: FeedbackType;
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface FeedbackEvent extends FeedbackInput {
  id: string;
  createdAt: string;
}

export interface KnowledgeFeedbackSummary {
  knowledgeId: string;
  selectedCount: number;
  selectedNoisyCount: number;
  rejectedCount: number;
  irrelevantCount: number;
  staleCount: number;
  latestFeedbackType?: FeedbackInput['feedbackType'];
  latestFeedbackAt?: string;
}

export interface ContextQualityReportInput {
  project?: string;
  feedbackType?: FeedbackQualityType;
  limit: number;
}

export interface ContextQualityPackSummary {
  id: string;
  project?: string;
  status: ContextPack['status'];
  prompt: string;
  confidence: number;
  fitStatus?: ContextFitStatus;
  fitScore?: number;
  missingSignals: string[];
}

export interface ContextQualitySessionSummary {
  id: string;
  status: AgentSessionStatus;
  outcome?: AgentSessionOutcome;
  prompt: string;
  summary?: string;
}

export interface ContextQualityItemSummary {
  knowledgeId: string;
  title: string;
  evidenceCategory?: ContextEvidenceCategory;
  evidenceStrength?: ContextEvidenceStrength;
  score: number;
  reasons: string[];
  missingSignals: string[];
}

export interface ContextQualityKnowledgeGapSummary {
  id: string;
  status: LearningReviewStatus;
  missingSignals: string[];
  reason?: string;
}

export interface ContextQualityLearningProposalSummary {
  id: string;
  status: LearningReviewStatus;
  proposalType: LearningProposalType;
  affectedKnowledgeId?: string;
  reason: string;
  evidence: string[];
}

export interface ContextQualityFeedbackRecord {
  feedback: FeedbackEvent;
  contextPack?: ContextQualityPackSummary;
  session?: ContextQualitySessionSummary;
  adjacentItems: ContextQualityItemSummary[];
  missingSignals: string[];
  openKnowledgeGaps: ContextQualityKnowledgeGapSummary[];
  openLearningProposals: ContextQualityLearningProposalSummary[];
  suggestedReviewActions: string[];
}

export interface ContextQualityReport {
  generatedAt: string;
  filters: ContextQualityReportInput;
  totalMatched: number;
  records: ContextQualityFeedbackRecord[];
  rollups: {
    feedbackTypes: Array<{ value: FeedbackQualityType; count: number }>;
    projects: Array<{ value: string; count: number }>;
    suggestedReviewActions: Array<{ value: string; count: number }>;
    missingSignals: Array<{ value: string; count: number }>;
    adjacentItems: Array<{ knowledgeId: string; title: string; count: number }>;
  };
}
