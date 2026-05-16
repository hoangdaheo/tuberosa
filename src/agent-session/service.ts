import { NotFoundError } from '../errors.js';
import type { ReflectionService } from '../reflection/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  AgentSessionDecisionResult,
  AgentSessionFinishResult,
  AgentSessionPolicy,
  AgentSessionStartResult,
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
    const reflectionDraft = input.reflectionDraft
      ? await this.reflection.createDraft({
        ...input.reflectionDraft,
        project: input.reflectionDraft.project ?? existingSession.project,
        metadata: {
          ...(input.reflectionDraft.metadata ?? {}),
          agentSessionId: input.sessionId,
        },
      })
      : undefined;

    const session = await this.store.finishAgentSession({
      ...input,
      reflectionDraftIds: reflectionDraft ? [reflectionDraft.id] : [],
    });
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${input.sessionId}`);
    }

    return { session, reflectionDraft };
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
