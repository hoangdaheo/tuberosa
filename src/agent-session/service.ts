import { NotFoundError } from '../errors.js';
import type { ReflectionService } from '../reflection/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  AgentSessionDecisionResult,
  AgentSessionFinishResult,
  AgentSessionPolicy,
  AgentSessionLearningDecision,
  AgentSessionStartResult,
  AgentContextCompliance,
  AgentSession,
  AgentContextDecision,
  ContextPack,
  ContextFitStatus,
  FinishAgentSessionInput,
  LabelInput,
  ReferenceInput,
  RecordAgentContextDecisionInput,
  ReflectionDraft,
  ReflectionDraftInput,
  StartAgentSessionInput,
} from '../types.js';
import { truncate, uniqueStrings } from '../util/text.js';

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
    const reflectionDraft = input.reflectionDraft
      ? await this.reflection.createDraft({
        ...input.reflectionDraft,
        project: input.reflectionDraft.project ?? existingSession.project,
        metadata: {
          ...(input.reflectionDraft.metadata ?? {}),
          agentSessionId: input.sessionId,
          contextPackId: input.reflectionDraft.metadata?.contextPackId ?? existingSession.initialContextPackId,
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
      : await this.createSessionLearning(input, existingSession, decisions, compliance);
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

    const summary = input.summary?.trim();
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
    const draftInput = buildLearningDraftInput(input, session, decisions, selectedPack);

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
    const selected = [...decisions].reverse().find((decision) => decision.decision === 'selected' && decision.contextPackId);
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
): ReflectionDraftInput {
  const classified = selectedPack?.classified;
  const references = learningReferences(session, selectedPack);
  const labels = learningLabels(session, selectedPack);
  const contextTitles = selectedPack?.sections
    .flatMap((section) => section.items.map((item) => item.title))
    .slice(0, 4) ?? [];
  const negativeDecisions = decisions
    .filter((decision) => decision.decision !== 'selected')
    .map((decision) => `${decision.decision}${decision.reason ? `: ${decision.reason}` : ''}`);

  return {
    project: session.project ?? selectedPack?.project,
    title: `Learn from session: ${truncate(session.prompt, 72)}`,
    summary: input.summary ?? session.prompt,
    content: [
      `User task: ${session.prompt}`,
      `Outcome: ${input.outcome}`,
      `Durable lesson: ${input.summary}`,
      contextTitles.length ? `Context used: ${contextTitles.join('; ')}` : undefined,
      negativeDecisions.length ? `Context corrections: ${negativeDecisions.join('; ')}` : undefined,
    ].filter(Boolean).join('\n'),
    itemType: itemTypeForTask(classified?.taskType),
    triggerType: triggerTypeForOutcome(input, decisions),
    labels,
    references,
    metadata: {
      taxonomy: taxonomyForTask(classified?.taskType),
      agentSessionId: session.id,
      contextPackId: selectedPack?.id ?? session.initialContextPackId,
      learningMode: input.learningMode ?? 'auto',
      source: 'agent_session_finish',
      contextFit: selectedPack?.contextFit,
      classifiedIntent: classified?.intent,
    },
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
  const reasons: string[] = [];

  if (input.mode !== 'auto') {
    reasons.push('auto approval disabled by learningMode');
  }

  if (input.input.outcome !== 'completed') {
    reasons.push('only completed sessions can auto-approve learning');
  }

  if (input.compliance.status !== 'compliant') {
    reasons.push(`context compliance is ${input.compliance.status}`);
  }

  if (!input.selectedPack || input.selectedPack.contextFit?.fitStatus !== 'ready') {
    reasons.push('selected context pack is missing or not ready');
  }

  if (input.decisions.some((decision) => ['rejected', 'irrelevant', 'stale', 'missing_context'].includes(decision.decision))) {
    reasons.push('session has negative or missing-context decisions');
  }

  if (input.draft.duplicateCandidates.length > 0) {
    reasons.push('similar approved memory already exists');
  }

  if (!hasGroundedReference(input.draft.references)) {
    reasons.push('learning candidate lacks a grounded non-conversation reference');
  }

  if (!input.draft.suggestedLabels.some((label) => label.type === 'task_type' || label.type === 'file' || label.type === 'symbol' || label.type === 'error')) {
    reasons.push('learning candidate lacks concrete task, file, symbol, or error labels');
  }

  if (input.draft.summary.length < 32 || input.draft.content.length < 100) {
    reasons.push('learning candidate is too short');
  }

  if (reasons.length === 0) {
    reasons.push('passed auto-learning safety, duplicate, evidence, and usefulness gates');
  }

  return {
    canAutoApprove: input.mode === 'auto' && reasons.length === 1 && reasons[0].startsWith('passed '),
    reasons,
  };
}

function learningReferences(session: AgentSession, selectedPack: ContextPack | undefined): ReferenceInput[] {
  const references: ReferenceInput[] = [
    { type: 'conversation', uri: `tuberosa://agent-sessions/${session.id}` },
  ];

  if (selectedPack) {
    references.push({ type: 'conversation', uri: `tuberosa://context-packs/${selectedPack.id}` });
    references.push(...selectedPack.sections.flatMap((section) => section.items.flatMap((item) => item.references)));
  }

  return uniqueReferences(references).slice(0, 12);
}

function learningLabels(session: AgentSession, selectedPack: ContextPack | undefined): LabelInput[] {
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

function itemTypeForTask(taskType: ContextPack['classified']['taskType'] | undefined): ReflectionDraftInput['itemType'] {
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
  const selected = decisions.filter((decision) => decision.decision === 'selected');
  const missing = decisions.filter((decision) => decision.decision === 'missing_context');
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
      instruction: 'Context was insufficient and missing_context was recorded for review.',
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
