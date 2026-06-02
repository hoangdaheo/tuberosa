import { z } from 'zod';
import type {
  AgentLearningSignal,
  ResearchTraceInput,
  StartAgentSessionInput,
  RecordAgentContextDecisionInput,
  AppendAgentSessionNoteInput,
} from '../types.js';
import {
  MAX_RESEARCH_TRACE_OUTCOME,
  MAX_RESEARCH_TRACE_STEP_TEXT,
  MAX_RESEARCH_TRACE_STEPS,
} from '../agent-session/research-trace.js';
import {
  FEEDBACK_TYPES,
  AGENT_SESSION_OUTCOMES,
  AGENT_LEARNING_MODES,
  AGENT_LEARNING_SIGNAL_KINDS,
  AGENT_LEARNING_SIGNAL_SOURCES,
  RESEARCH_TRACE_STEP_KINDS,
} from './enums.js';
import { zRequiredString, zOptionalString, zStringArray, zConfidence, zRecord } from './primitives.js';
import { optionalReferencesSchema } from './common.js';
import { contextSearchSchema } from './context.js';
import { reflectionDraftSchema } from './reflection.js';

/** Single learning-signal shape (matches readLearningSignal). */
export const learningSignalSchema = z.object({
  kind: z.enum(AGENT_LEARNING_SIGNAL_KINDS),
  text: zRequiredString,
  source: z.enum(AGENT_LEARNING_SIGNAL_SOURCES).optional(),
  files: zStringArray.optional(),
  symbols: zStringArray.optional(),
  errors: zStringArray.optional(),
  references: optionalReferencesSchema,
  confidence: zConfidence.optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<AgentLearningSignal>;

/**
 * Research trace (matches readOptionalResearchTrace): bounded outcome, bounded
 * step count, each step a bounded text + kind enum + optional references that
 * must each include at least one of file/symbol/command/knowledgeId.
 */
const researchTraceReferenceSchema = z
  .object({
    file: zOptionalString,
    symbol: zOptionalString,
    command: zOptionalString,
    knowledgeId: zOptionalString,
  })
  .refine((r) => Boolean(r.file || r.symbol || r.command || r.knowledgeId), {
    message: 'must include file, symbol, command, or knowledgeId.',
  });

const researchTraceStepSchema = z.object({
  kind: z.enum(RESEARCH_TRACE_STEP_KINDS),
  text: zRequiredString.refine((s) => s.length <= MAX_RESEARCH_TRACE_STEP_TEXT, {
    message: `must be ${MAX_RESEARCH_TRACE_STEP_TEXT} characters or fewer.`,
  }),
  references: z.array(researchTraceReferenceSchema).optional(),
});

export const researchTraceSchema = z.object({
  outcome: zRequiredString.refine((s) => s.length <= MAX_RESEARCH_TRACE_OUTCOME, {
    message: `must be ${MAX_RESEARCH_TRACE_OUTCOME} characters or fewer.`,
  }),
  steps: z.array(researchTraceStepSchema).max(MAX_RESEARCH_TRACE_STEPS, {
    message: `must contain ${MAX_RESEARCH_TRACE_STEPS} or fewer steps.`,
  }),
}) as z.ZodType<ResearchTraceInput>;

/** start: contextSearch fields + agent metadata. */
export const startAgentSessionSchema = (contextSearchSchema as unknown as z.ZodObject<z.ZodRawShape>).extend({
  agentName: zOptionalString,
  agentTool: zOptionalString,
  metadata: zRecord.optional(),
}) as unknown as z.ZodType<StartAgentSessionInput>;

/** record-decision: sessionId required, feedbackType required. */
export const recordContextDecisionSchema = z.object({
  sessionId: zRequiredString,
  contextPackId: zOptionalString,
  feedbackType: z.enum(FEEDBACK_TYPES),
  reason: zOptionalString,
  rejectedKnowledgeIds: zStringArray.optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<RecordAgentContextDecisionInput>;

/** finish: sessionId + outcome required, optional bag, reflectionDraft delegates. */
export const finishAgentSessionSchema = z.object({
  sessionId: zRequiredString,
  outcome: z.enum(AGENT_SESSION_OUTCOMES),
  summary: zOptionalString,
  agentOutputSummary: zOptionalString,
  changedFiles: zStringArray.optional(),
  verificationCommands: zStringArray.optional(),
  learningSignals: z.array(learningSignalSchema).optional(),
  contextBypassReason: zOptionalString,
  learningMode: z.enum(AGENT_LEARNING_MODES).optional(),
  metadata: zRecord.optional(),
  researchTrace: researchTraceSchema.optional(),
  reflectionDraft: reflectionDraftSchema.optional(),
});

/** capture-learning-signal: signal shape + sessionId/author/contextPackId. */
export const captureLearningSignalSchema = (learningSignalSchema as unknown as z.ZodObject<z.ZodRawShape>).extend({
  sessionId: zRequiredString,
  author: zOptionalString,
  contextPackId: zOptionalString,
});

/** append-note: sessionId + note required, optional feedback bag. */
export const appendSessionNoteSchema = z.object({
  sessionId: zRequiredString,
  note: zRequiredString,
  author: zOptionalString,
  feedbackType: z.enum(FEEDBACK_TYPES).optional(),
  contextPackId: zOptionalString,
  reason: zOptionalString,
  rejectedKnowledgeIds: zStringArray.optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<AppendAgentSessionNoteInput>;
