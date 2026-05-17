import { NotFoundError } from '../errors.js';
import type { ReflectionService } from '../reflection/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  AgentSessionDecisionResult,
  AgentSessionFinishResult,
  AgentSessionPolicy,
  AgentSessionStartResult,
  AgentContextCompliance,
  AgentSession,
  ContextFitStatus,
  FinishAgentSessionInput,
  RecordAgentContextDecisionInput,
  StartAgentSessionInput,
} from '../types.js';

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

    const session = await this.store.finishAgentSession({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        contextCompliance: compliance,
      },
      reflectionDraftIds: reflectionDraft ? [reflectionDraft.id] : [],
    });
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${input.sessionId}`);
    }

    return { session, reflectionDraft, compliance };
  }

  private async requireSession(id: string) {
    const session = await this.store.getAgentSession(id);
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${id}`);
    }

    return session;
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
