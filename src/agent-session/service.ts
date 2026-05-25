import { NotFoundError } from '../errors.js';
import { evaluateGates } from '../reflection/recommendation.js';
import type { ReflectionService } from '../reflection/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  AgentSessionDecisionResult,
  AgentSessionFinishResult,
  AgentSessionPolicy,
  AgentSessionLearningDecision,
  AgentSessionNote,
  AgentSessionStartResult,
  AgentContextCompliance,
  AgentSession,
  AgentContextDecision,
  AgentLearningSignal,
  AppendAgentSessionNoteInput,
  AppendAgentSessionNoteResult,
  CaptureAgentLearningSignalInput,
  CaptureAgentLearningSignalResult,
  ContextPack,
  ContextFitStatus,
  FeedbackEvent,
  FinishAgentSessionInput,
  LabelInput,
  ReferenceInput,
  ResearchTraceSummary,
  RecordAgentContextDecisionInput,
  ReflectionDraft,
  ReflectionDraftInput,
  StartAgentSessionInput,
} from '../types.js';
import { truncate, uniqueStrings } from '../util/text.js';
import { deriveResearchTrace, normalizeResearchTrace } from './research-trace.js';

export class AgentSessionService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly retrieval: RetrievalService,
    private readonly reflection: ReflectionService,
  ) {}

  async startSession(input: StartAgentSessionInput): Promise<AgentSessionStartResult> {
    const contextPack = await this.retrieval.searchContext(input);
    const session = await this.store.createAgentSession({
      prompt: input.prompt,
      project: input.project ?? contextPack.project,
      cwd: input.cwd,
      agentName: input.agentName,
      agentTool: input.agentTool,
      initialContextPackId: contextPack.id,
      metadata: input.metadata,
    });

    return {
      session,
      contextPack,
      policy: sessionPolicy(contextPack.contextFit?.fitStatus),
    };
  }

  async recordContextDecision(input: RecordAgentContextDecisionInput): Promise<AgentSessionDecisionResult> {
    const session = await this.requireSession(input.sessionId);
    const feedback = await this.retrieval.recordFeedback({
      contextPackId: input.contextPackId,
      project: session.project,
      feedbackType: input.feedbackType,
      reason: input.reason,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
      metadata: {
        ...(input.metadata ?? {}),
        agentSessionId: session.id,
      },
    });
    const decision = await this.store.recordAgentContextDecision({
      ...input,
      retryContextPackId: feedback.retry?.id,
    });
    const updatedSession = await this.requireSession(session.id);

    return {
      session: updatedSession,
      decision,
      retry: feedback.retry,
      policy: feedback.retry ? sessionPolicy(feedback.retry.contextFit?.fitStatus) : undefined,
    };
  }

  async finishSession(input: FinishAgentSessionInput): Promise<AgentSessionFinishResult> {
    const existingSession = await this.requireSession(input.sessionId);
    const decisions = await this.store.listAgentContextDecisions({ sessionId: input.sessionId, limit: 100 });
    const compliance = sessionCompliance(existingSession, decisions, input.contextBypassReason);
    const learningSignals = sessionLearningSignals(input, existingSession);
    const researchTrace = input.researchTrace
      ? normalizeResearchTrace(input.researchTrace)
      : deriveResearchTrace({
        learningSignals,
        sessionNotes: sessionNotesFromMetadata(existingSession.metadata),
        contextDecisions: decisions,
        changedFiles: input.changedFiles,
        verificationCommands: input.verificationCommands,
        outcome: input.summary?.trim() || input.agentOutputSummary?.trim() || `Session finished with outcome ${input.outcome}.`,
      });
    const reflectionDraft = input.reflectionDraft
      ? await this.reflection.createDraft({
        ...input.reflectionDraft,
        project: input.reflectionDraft.project ?? existingSession.project,
        metadata: {
          ...(input.reflectionDraft.metadata ?? {}),
          agentSessionId: input.sessionId,
          contextPackId: input.reflectionDraft.metadata?.contextPackId ?? existingSession.initialContextPackId,
          researchTrace,
        },
      })
      : undefined;
    const learning = reflectionDraft
      ? {
        decision: {
          mode: input.learningMode ?? 'auto',
          status: 'skipped',
          reasons: ['explicit reflectionDraft was provided'],
          draftId: reflectionDraft.id,
        } satisfies AgentSessionLearningDecision,
      }
      : await this.createSessionLearning(input, existingSession, decisions, compliance, researchTrace, learningSignals);
    const reflectionDraftIds = [
      ...(reflectionDraft ? [reflectionDraft.id] : []),
      ...(learning.draft && learning.draft.id !== reflectionDraft?.id ? [learning.draft.id] : []),
    ];

    const session = await this.store.finishAgentSession({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        contextCompliance: compliance,
        agentLearning: learning.decision,
        researchTrace,
      },
      reflectionDraftIds,
    });
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${input.sessionId}`);
    }

    return {
      session,
      reflectionDraft: reflectionDraft ?? learning.draft,
      learningCandidate: learning.draft,
      autoApprovedMemory: learning.approvedDraft,
      learningDecision: learning.decision,
      compliance,
    };
  }

  async appendSessionNote(input: AppendAgentSessionNoteInput): Promise<AppendAgentSessionNoteResult> {
    const session = await this.requireSession(input.sessionId);
    const feedback = await this.recordSessionNoteFeedback(input, session);
    const note: AgentSessionNote = {
      at: new Date().toISOString(),
      note: input.note,
      author: input.author,
      feedbackType: input.feedbackType,
      feedbackId: feedback?.id,
      contextPackId: input.contextPackId,
      metadata: input.metadata,
    };
    const updated = await this.store.appendAgentSessionNote({ sessionId: session.id, note });
    return { session: updated ?? session, note, feedback };
  }

  async captureLearningSignal(input: CaptureAgentLearningSignalInput): Promise<CaptureAgentLearningSignalResult> {
    const signal = normalizeLearningSignal(input);
    const result = await this.appendSessionNote({
      sessionId: input.sessionId,
      note: learningSignalNote(signal),
      author: input.author ?? signal.source,
      contextPackId: input.contextPackId,
      metadata: {
        learningSignal: signal,
      },
    });

    return { ...result, signal };
  }

  private async recordSessionNoteFeedback(
    input: AppendAgentSessionNoteInput,
    session: AgentSession,
  ): Promise<FeedbackEvent | undefined> {
    if (!input.feedbackType) {
      return undefined;
    }

    const result = await this.retrieval.recordFeedback({
      contextPackId: input.contextPackId,
      project: session.project,
      feedbackType: input.feedbackType,
      reason: input.reason ?? input.note,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
      metadata: {
        ...(input.metadata ?? {}),
        agentSessionId: session.id,
        postFinishNote: true,
      },
    });
    return result.feedback;
  }

  private async requireSession(id: string) {
    const session = await this.store.getAgentSession(id);
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${id}`);
    }

    return session;
  }

  private async createSessionLearning(
    input: FinishAgentSessionInput,
    session: AgentSession,
    decisions: AgentContextDecision[],
    compliance: AgentContextCompliance,
    researchTrace?: ResearchTraceSummary,
    precomputedLearningSignals?: AgentLearningSignal[],
  ): Promise<SessionLearningResult> {
    const mode = input.learningMode ?? 'auto';
    if (mode === 'off') {
      return {
        decision: {
          mode,
          status: 'skipped',
          reasons: ['learningMode is off'],
        },
      };
    }

    if (input.outcome === 'cancelled') {
      return {
        decision: {
          mode,
          status: 'skipped',
          reasons: ['cancelled sessions are not learned automatically'],
        },
      };
    }

    const learningSignals = precomputedLearningSignals ?? sessionLearningSignals(input, session);
    const summary = durableLearningSummary(input, learningSignals);
    if (!summary || summary.length < 24) {
      return {
        decision: {
          mode,
          status: 'skipped',
          reasons: ['finish summary is too short to extract a durable lesson'],
        },
      };
    }

    const selectedPack = await this.selectedContextPack(session, decisions);
    const draftInput = buildLearningDraftInput(input, session, decisions, selectedPack, learningSignals, summary, researchTrace);

    try {
      const draft = await this.reflection.createDraft(draftInput);
      const gate = learningGate({
        mode,
        input,
        compliance,
        decisions,
        selectedPack,
        draft,
      });

      if (gate.canAutoApprove) {
        const approved = await this.reflection.approveDraft(draft.id);
        return {
          draft: approved ?? draft,
          approvedDraft: approved ?? draft,
          decision: {
            mode,
            status: 'auto_approved',
            reasons: gate.reasons,
            draftId: draft.id,
          },
        };
      }

      if (mode === 'auto') {
        const reviewedDraft = await this.store.updateReflectionDraft(draft.id, {
          status: 'needs_changes',
          metadata: {
            ...draft.metadata,
            agentLearning: {
              mode,
              gateStatus: 'needs_review',
              reasons: gate.reasons,
            },
          },
        });

        return {
          draft: reviewedDraft ?? draft,
          decision: {
            mode,
            status: 'drafted',
            reasons: gate.reasons,
            draftId: draft.id,
          },
        };
      }

      return {
        draft,
        decision: {
          mode,
          status: 'drafted',
          reasons: ['learningMode is draft_only', ...gate.reasons],
          draftId: draft.id,
        },
      };
    } catch (error) {
      return {
        decision: {
          mode,
          status: 'rejected',
          reasons: [`learning candidate failed safety or validation: ${error instanceof Error ? error.message : String(error)}`],
        },
      };
    }
  }

  private async selectedContextPack(session: AgentSession, decisions: AgentContextDecision[]) {
    const selected = [...decisions].reverse().find((decision) => isSelectedDecision(decision.decision) && decision.contextPackId);
    const packId = selected?.contextPackId ?? session.initialContextPackId;
    return packId ? this.store.getContextPack(packId) : undefined;
  }
}

export function sessionPolicy(fitStatus: ContextFitStatus | undefined): AgentSessionPolicy {
  if (fitStatus === 'ready') {
    return {
      action: 'proceed',
      instruction: 'Context fit is ready. Record a selected context decision before using the pack.',
    };
  }

  if (fitStatus === 'needs_confirmation') {
    return {
      action: 'confirm',
      instruction: 'Context fit needs confirmation. Review the shortlist before relying on the pack.',
    };
  }

  return {
    action: 'clarify',
    instruction: 'Context fit is insufficient. Ask for clarification or continue with fresh context.',
  };
}

interface SessionLearningResult {
  draft?: ReflectionDraft;
  approvedDraft?: ReflectionDraft;
  decision: AgentSessionLearningDecision;
}

function buildLearningDraftInput(
  input: FinishAgentSessionInput,
  session: AgentSession,
  decisions: AgentContextDecision[],
  selectedPack: ContextPack | undefined,
  learningSignals: AgentLearningSignal[],
  summary: string,
  researchTrace?: ResearchTraceSummary,
): ReflectionDraftInput {
  const classified = selectedPack?.classified;
  const references = learningReferences(session, selectedPack, input, learningSignals);
  const labels = learningLabels(session, selectedPack, input, learningSignals);
  const contextTitles = selectedPack?.sections
    .flatMap((section) => section.items.map((item) => item.title))
    .slice(0, 4) ?? [];
  const negativeDecisions = decisions
    .filter((decision) => !isSelectedDecision(decision.decision))
    .map((decision) => `${decision.decision}${decision.reason ? `: ${decision.reason}` : ''}`);
  const learningSignalLines = learningSignals.map(formatLearningSignal);
  const changedFiles = uniqueStrings(input.changedFiles ?? []);
  const verificationCommands = uniqueStrings(input.verificationCommands ?? []);

  return {
    project: session.project ?? selectedPack?.project,
    title: `Learn from session: ${truncate(session.prompt, 72)}`,
    summary,
    content: [
      `User task: ${session.prompt}`,
      `Outcome: ${input.outcome}`,
      `Durable lesson: ${summary}`,
      input.agentOutputSummary?.trim() ? `Agent output summary: ${input.agentOutputSummary.trim()}` : undefined,
      changedFiles.length ? `Changed files: ${changedFiles.join(', ')}` : undefined,
      verificationCommands.length ? `Verification commands: ${verificationCommands.join('; ')}` : undefined,
      contextTitles.length ? `Context used: ${contextTitles.join('; ')}` : undefined,
      negativeDecisions.length ? `Context corrections: ${negativeDecisions.join('; ')}` : undefined,
      learningSignalLines.length ? `Learning signals:\n${learningSignalLines.join('\n')}` : undefined,
    ].filter(Boolean).join('\n'),
    itemType: itemTypeForTask(classified?.taskType, learningSignals),
    triggerType: triggerTypeForOutcome(input, decisions),
    labels,
    references,
    metadata: compactRecord({
      taxonomy: taxonomyForTask(classified?.taskType),
      agentSessionId: session.id,
      contextPackId: selectedPack?.id ?? session.initialContextPackId,
      learningMode: input.learningMode ?? 'auto',
      source: 'agent_session_finish',
      contextFit: selectedPack?.contextFit,
      classifiedIntent: classified?.intent,
      agentOutputSummary: input.agentOutputSummary?.trim(),
      changedFiles,
      verificationCommands,
      learningSignals,
      learningSignalCount: learningSignals.length,
      researchTrace,
    }),
  };
}

function learningGate(input: {
  mode: 'auto' | 'draft_only' | 'off';
  input: FinishAgentSessionInput;
  compliance: AgentContextCompliance;
  decisions: AgentContextDecision[];
  selectedPack?: ContextPack;
  draft: ReflectionDraft;
}): { canAutoApprove: boolean; reasons: string[] } {
  const gates = evaluateGates({
    draft: input.draft,
    mode: input.mode,
    outcome: input.input.outcome,
    compliance: input.compliance,
    decisions: input.decisions,
    selectedPack: input.selectedPack,
  });

  const failures = gates.filter((gate) => gate.status !== 'pass');
  const canAutoApprove = input.mode === 'auto' && failures.length === 0;
  const reasons = canAutoApprove
    ? ['passed auto-learning safety, duplicate, evidence, and usefulness gates']
    : failures.map((gate) => `${gate.label.toLowerCase()}: ${gate.message}`);

  return { canAutoApprove, reasons };
}

function learningReferences(
  session: AgentSession,
  selectedPack: ContextPack | undefined,
  input: FinishAgentSessionInput,
  learningSignals: AgentLearningSignal[],
): ReferenceInput[] {
  const references: ReferenceInput[] = [
    { type: 'conversation', uri: `tuberosa://agent-sessions/${session.id}` },
  ];

  if (selectedPack) {
    references.push({ type: 'conversation', uri: `tuberosa://context-packs/${selectedPack.id}` });
    references.push(...selectedPack.sections.flatMap((section) => section.items.flatMap((item) => item.references)));
  }

  references.push(...(input.changedFiles ?? []).map((uri) => ({ type: 'file' as const, uri })));
  references.push(...learningSignals.flatMap((signal) => [
    ...(signal.files ?? []).map((uri) => ({ type: 'file' as const, uri })),
    ...(signal.references ?? []),
  ]));

  return uniqueReferences(references).slice(0, 12);
}

function learningLabels(
  session: AgentSession,
  selectedPack: ContextPack | undefined,
  input: FinishAgentSessionInput,
  learningSignals: AgentLearningSignal[],
): LabelInput[] {
  const classified = selectedPack?.classified;
  const labels: LabelInput[] = [];

  if (session.project ?? selectedPack?.project) {
    labels.push({ type: 'project', value: session.project ?? selectedPack?.project ?? '', weight: 1 });
  }

  if (classified?.taskType && classified.taskType !== 'unknown') {
    labels.push({ type: 'task_type', value: classified.taskType, weight: 0.9 });
  }

  labels.push(
    ...(classified?.files ?? []).slice(0, 8).map((value) => ({ type: 'file' as const, value, weight: 0.9 })),
    ...(classified?.symbols ?? []).slice(0, 8).map((value) => ({ type: 'symbol' as const, value, weight: 0.85 })),
    ...(classified?.errors ?? []).slice(0, 4).map((value) => ({ type: 'error' as const, value, weight: 0.95 })),
    ...(classified?.technologies ?? []).slice(0, 4).map((value) => ({ type: 'technology' as const, value, weight: 0.75 })),
    ...(classified?.businessAreas ?? []).slice(0, 4).map((value) => ({ type: 'business_area' as const, value, weight: 0.8 })),
    ...(input.changedFiles ?? []).slice(0, 8).map((value) => ({ type: 'file' as const, value, weight: 0.9 })),
    ...learningSignals.flatMap(signalLabels),
  );

  return uniqueLabels(labels);
}

function triggerTypeForOutcome(input: FinishAgentSessionInput, decisions: AgentContextDecision[]): ReflectionDraftInput['triggerType'] {
  if (decisions.some((decision) => decision.decision === 'rejected' || decision.decision === 'stale' || decision.decision === 'irrelevant')) {
    return 'user_correction';
  }

  if (input.outcome === 'failed' || input.outcome === 'blocked') {
    return 'error_recovery';
  }

  return 'complex_task_success';
}

function itemTypeForTask(
  taskType: ContextPack['classified']['taskType'] | undefined,
  learningSignals: AgentLearningSignal[] = [],
): ReflectionDraftInput['itemType'] {
  if (learningSignals.some((signal) => signal.kind === 'mistake' || (signal.errors?.length ?? 0) > 0)) {
    return 'bugfix';
  }

  if (learningSignals.some((signal) => signal.kind === 'user_preference')) {
    return 'rule';
  }

  if (learningSignals.some((signal) => signal.kind === 'verification' || signal.kind === 'file_change')) {
    return 'workflow';
  }

  if (taskType === 'debugging') {
    return 'bugfix';
  }

  if (taskType === 'implementation' || taskType === 'refactor' || taskType === 'testing') {
    return 'workflow';
  }

  return 'memory';
}

function taxonomyForTask(taskType: ContextPack['classified']['taskType'] | undefined): string {
  if (taskType === 'debugging') {
    return 'incident_lesson';
  }

  if (taskType === 'implementation' || taskType === 'refactor' || taskType === 'testing') {
    return 'workflow';
  }

  return 'project_fact';
}

function hasGroundedReference(references: ReferenceInput[]): boolean {
  return references.some((reference) => reference.type !== 'conversation');
}

function uniqueReferences(references: ReferenceInput[]): ReferenceInput[] {
  const seen = new Set<string>();
  const unique: ReferenceInput[] = [];

  for (const reference of references) {
    const key = `${reference.type}:${reference.uri}`;
    if (!reference.uri || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(reference);
  }

  return unique;
}

function uniqueLabels(labels: LabelInput[]): LabelInput[] {
  const keys = uniqueStrings(labels.map((label) => `${label.type}:${label.value}`.toLowerCase()));
  return keys.map((key) => {
    const [type, ...valueParts] = key.split(':');
    const value = valueParts.join(':');
    const original = labels.find((label) => label.type === type && label.value.toLowerCase() === value);
    return original ?? { type: type as LabelInput['type'], value };
  });
}

function sessionCompliance(
  session: AgentSession,
  decisions: Array<{ id: string; decision: string }>,
  contextBypassReason: string | undefined,
): AgentContextCompliance {
  const selected = decisions.filter((decision) => isSelectedDecision(decision.decision));
  const missing = decisions.filter((decision) => isMissingContextDecision(decision.decision));
  const decisionIds = decisions.map((decision) => decision.id);
  const checkedAt = new Date().toISOString();

  if (contextBypassReason) {
    return {
      status: 'bypassed',
      checkedAt,
      instruction: 'Context was explicitly bypassed. Review the bypass reason before treating this session as context-covered.',
      decisionIds,
      contextPackId: session.initialContextPackId,
      bypassReason: contextBypassReason,
    };
  }

  if (selected.length > 0) {
    return {
      status: 'compliant',
      checkedAt,
      instruction: 'Context was selected before the session finished.',
      decisionIds,
      contextPackId: session.initialContextPackId,
    };
  }

  if (missing.length > 0) {
    return {
      status: 'missing_context_recorded',
      checkedAt,
      instruction: 'Context was insufficient or missing a required quality signal, and feedback was recorded for review.',
      decisionIds,
      contextPackId: session.initialContextPackId,
    };
  }

  if (session.initialContextPackId) {
    return {
      status: 'needs_decision',
      checkedAt,
      instruction: 'A context pack was fetched, but no selected or missing_context decision was recorded.',
      decisionIds,
      contextPackId: session.initialContextPackId,
    };
  }

  return {
    status: 'non_compliant',
    checkedAt,
    instruction: 'No context pack or explicit bypass reason was recorded for this session.',
    decisionIds,
  };
}

function isSelectedDecision(decision: string): boolean {
  return decision === 'selected' || decision === 'selected_but_noisy';
}

function isMissingContextDecision(decision: string): boolean {
  return decision === 'missing_context'
    || decision === 'missing_orientation'
    || decision === 'missing_current_handoff'
    || decision === 'missing_verification_commands';
}

function durableLearningSummary(input: FinishAgentSessionInput, learningSignals: AgentLearningSignal[]): string | undefined {
  const explicit = input.summary?.trim() || input.agentOutputSummary?.trim();
  if (explicit) {
    return explicit;
  }

  const signalSummary = learningSignals
    .map((signal) => signal.text.trim())
    .filter(Boolean)
    .join(' ');

  return signalSummary ? truncate(signalSummary, 500) : undefined;
}

function sessionLearningSignals(input: FinishAgentSessionInput, session: AgentSession): AgentLearningSignal[] {
  return uniqueLearningSignals([
    ...(input.learningSignals ?? []).map(normalizeLearningSignal),
    ...learningSignalsFromNotes(session.metadata),
  ]);
}

function learningSignalsFromNotes(metadata: Record<string, unknown>): AgentLearningSignal[] {
  if (!Array.isArray(metadata.notes)) {
    return [];
  }

  return metadata.notes
    .map((note) => note && typeof note === 'object'
      ? (note as { metadata?: Record<string, unknown> }).metadata?.learningSignal
      : undefined)
    .filter(isLearningSignalRecord)
    .map(normalizeLearningSignal);
}

function sessionNotesFromMetadata(metadata: Record<string, unknown>): AgentSessionNote[] {
  if (!Array.isArray(metadata.notes)) {
    return [];
  }

  return metadata.notes.filter((note): note is AgentSessionNote => (
    Boolean(note)
    && typeof note === 'object'
    && typeof (note as AgentSessionNote).note === 'string'
    && typeof (note as AgentSessionNote).at === 'string'
  ));
}

function hasLowConfidenceLearningSignals(metadata: Record<string, unknown> | undefined): boolean {
  const signals = metadata?.learningSignals;
  if (!Array.isArray(signals)) {
    return false;
  }

  return signals
    .filter(isLearningSignalRecord)
    .some((signal) => signal.confidence !== undefined && signal.confidence < 0.6);
}

function normalizeLearningSignal(input: AgentLearningSignal): AgentLearningSignal {
  const files = uniqueStrings(input.files ?? []);
  const symbols = uniqueStrings(input.symbols ?? []);
  const errors = uniqueStrings(input.errors ?? []);
  const signal: AgentLearningSignal = {
    kind: input.kind,
    text: input.text.trim(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  if (input.source) {
    signal.source = input.source;
  }
  if (files.length) {
    signal.files = files;
  }
  if (symbols.length) {
    signal.symbols = symbols;
  }
  if (errors.length) {
    signal.errors = errors;
  }
  if (input.references?.length) {
    signal.references = input.references;
  }
  if (input.confidence !== undefined) {
    signal.confidence = input.confidence;
  }
  if (input.metadata) {
    signal.metadata = input.metadata;
  }

  return signal;
}

function uniqueLearningSignals(signals: AgentLearningSignal[]): AgentLearningSignal[] {
  const seen = new Set<string>();
  const unique: AgentLearningSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.text}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(signal);
  }
  return unique;
}

function isLearningSignalRecord(value: unknown): value is AgentLearningSignal {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AgentLearningSignal>;
  return typeof record.kind === 'string' && typeof record.text === 'string' && record.text.trim().length > 0;
}

function learningSignalNote(signal: AgentLearningSignal): string {
  return `[learning:${signal.kind}] ${signal.text}`;
}

function formatLearningSignal(signal: AgentLearningSignal): string {
  const evidence = [
    signal.files?.length ? `files=${signal.files.join(',')}` : undefined,
    signal.symbols?.length ? `symbols=${signal.symbols.join(',')}` : undefined,
    signal.errors?.length ? `errors=${signal.errors.join(',')}` : undefined,
  ].filter(Boolean).join(' ');
  return `- ${signal.kind}: ${signal.text}${evidence ? ` (${evidence})` : ''}`;
}

function signalLabels(signal: AgentLearningSignal): LabelInput[] {
  return [
    ...(signal.files ?? []).slice(0, 8).map((value) => ({ type: 'file' as const, value, weight: 0.9 })),
    ...(signal.symbols ?? []).slice(0, 8).map((value) => ({ type: 'symbol' as const, value, weight: 0.85 })),
    ...(signal.errors ?? []).slice(0, 4).map((value) => ({ type: 'error' as const, value, weight: 0.95 })),
  ];
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => (
    value !== undefined
    && (!Array.isArray(value) || value.length > 0)
  )));
}
