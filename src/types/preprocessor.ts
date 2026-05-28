import type { ContextSearchInput, TaskType } from './retrieval.js';

export type LengthClass = 'short' | 'medium' | 'long';
export type EmbeddingSource = 'original' | 'primary_intent' | 'anchor_window';
export type SignalReason = 'frequency' | 'code_block' | 'imperative_proximity' | 'cwd_match';

export interface ScoredSignal {
  value: string;
  score: number;
  reasons: SignalReason[];
}

export interface StructuralSignals {
  files: ScoredSignal[];
  symbols: ScoredSignal[];
  errors: ScoredSignal[];
  technologies: ScoredSignal[];
  businessAreas: ScoredSignal[];
}

export interface PromptIntentVerdict {
  primary: string;
  subTasks: string[];
  detectedTaskType?: TaskType;
  detectedTechnologies?: string[];
  confidence: number;
}

export interface PromptPreprocessingResult {
  lengthClass: LengthClass;
  originalTokenEstimate: number;
  embeddingSource: EmbeddingSource;
  primaryIntent?: string;
  subTasks?: string[];
  structuralSignals: StructuralSignals;
  continuationGated: boolean;
  cacheHits: { intent: boolean; signals: boolean };
}

export interface PreprocessedInput extends ContextSearchInput {
  promptPreprocessing?: PromptPreprocessingResult;
}
