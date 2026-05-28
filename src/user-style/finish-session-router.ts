import type { AtomCritic } from '../atoms/critic.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import { createUserStyleAtom, userScopeProject } from './store-helpers.js';

export interface UserPreferenceSignal {
  text: string;
  type?: 'convention' | 'gotcha' | 'decision' | 'fact';
}

export interface RouteUserPreferenceResult {
  atomId?: string;
  rejected?: boolean;
  reasons?: string[];
}

/**
 * Concern F — when finish-session sees a `user_preference` learning signal and
 * the runtime has a configured TUBEROSA_USER_ID, dry-run the critic on the
 * proposed user-style atom. Accepts → persist (draft tier, coding_preference
 * priority). Rejects → record a knowledge gap so the workbench can review.
 *
 * The shape mirrors the existing project-atom extractor flow so failures are
 * captured rather than silently dropped.
 */
export async function routeUserPreferenceSignal(
  store: KnowledgeStore,
  critic: AtomCritic,
  input: { userId: string; sessionId: string; signal: UserPreferenceSignal },
): Promise<RouteUserPreferenceResult> {
  const claim = input.signal.text;
  const type = input.signal.type ?? 'convention';

  const candidate: KnowledgeAtomInput = {
    project: userScopeProject(input.userId),
    claim,
    type,
    evidence: [{ kind: 'prior_session', sessionId: input.sessionId }],
    trigger: { intentTags: ['user_preference'] },
    producedBy: 'agent_session',
    scope: 'user',
    userId: input.userId,
    priority: 'coding_preference',
  };

  const verdict = await critic.evaluate(candidate, input.sessionId);
  if (verdict.outcome !== 'accepted' && verdict.outcome !== 'pending') {
    await store.createKnowledgeGap({
      project: undefined,
      sourceSessionId: input.sessionId,
      prompt: claim,
      missingSignals: ['user_style_critic'],
      reason: verdict.reasons.join('; ') || 'user_style critic rejected',
      metadata: { source: 'user_style_critic', userId: input.userId },
    });
    return { rejected: true, reasons: verdict.reasons };
  }

  const atom = await createUserStyleAtom(store, {
    userId: input.userId,
    claim,
    type,
    priority: 'coding_preference',
    trigger: { intentTags: ['user_preference'] },
    sessionId: input.sessionId,
  });
  return { atomId: atom.id };
}
