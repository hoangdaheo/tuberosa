import type { KnowledgeStore } from '../storage/store.js';
import type {
  Evidence,
  KnowledgeAtom,
  KnowledgeAtomInput,
  StylePriority,
  Trigger,
} from '../types/atoms.js';

/**
 * Concern F — sentinel project name used by user-style atoms so the in-memory
 * store has a consistent indexing key. The Postgres store strips this on
 * insert (project_id is NULL) and re-synthesises it on read in rowToAtom.
 */
export function userScopeProject(userId: string): string {
  return `__user:${userId}`;
}

export interface CreateUserStyleAtomInput {
  userId: string;
  claim: string;
  type: 'convention' | 'gotcha' | 'decision' | 'fact';
  priority: StylePriority;
  trigger: Trigger;
  evidence?: Evidence[];
  pitfalls?: string[];
  sessionId?: string;
}

/**
 * Persist a cross-project, single-user style atom. Invariants:
 *   - scope='user', a userId + priority are required (enforced by types).
 *   - type='procedure' is rejected — user-style is for short stylistic claims;
 *     multi-step procedures belong in a project workflow or wiki.
 *   - When the caller passes a sessionId but no evidence, we auto-insert a
 *     `prior_session` evidence row so the atom is grounded.
 *   - When neither evidence nor sessionId is provided, metadata.lowEvidence=true
 *     so the workbench can prioritise the atom for review.
 */
export async function createUserStyleAtom(
  store: KnowledgeStore,
  input: CreateUserStyleAtomInput,
): Promise<KnowledgeAtom> {
  if ((input.type as string) === 'procedure') {
    throw new Error(
      'User-style atoms cannot be of type=procedure; use a project workflow or wiki instead.',
    );
  }

  const evidence: Evidence[] = input.evidence ? [...input.evidence] : [];
  if (evidence.length === 0 && input.sessionId) {
    evidence.push({ kind: 'prior_session', sessionId: input.sessionId });
  }
  const lowEvidence = evidence.length === 0;

  const atomInput: KnowledgeAtomInput = {
    project: userScopeProject(input.userId),
    claim: input.claim,
    type: input.type,
    evidence,
    trigger: input.trigger,
    pitfalls: input.pitfalls,
    producedBy: 'user',
    producedAtSessionId: input.sessionId,
    scope: 'user',
    userId: input.userId,
    priority: input.priority,
    metadata: lowEvidence ? { lowEvidence: true } : {},
  };

  return store.createAtom(atomInput);
}
