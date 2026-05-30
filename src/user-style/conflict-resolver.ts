import type { RankedCandidate } from '../types.js';

const NEGATION_RE = /\b(not|never|don't|avoid|without|no)\b/i;

/**
 * Heuristic contradiction detector between a user-style claim and a project
 * convention claim. A pair is treated as contradictory iff:
 *   1. Exactly one side carries a negation marker (negation imbalance).
 *   2. After stripping negations, ≥50% of the shorter side's content words
 *      appear in the other (high topical overlap).
 *
 * Two literal opposites like "Use default exports." vs. "Never use default
 * exports." satisfy both clauses; unrelated claims fall out on clause 2.
 */
function isContradiction(userClaim: string, projectClaim: string): boolean {
  const userNeg = NEGATION_RE.test(userClaim);
  const projNeg = NEGATION_RE.test(projectClaim);
  if (userNeg === projNeg) return false;

  const tokensA = contentTokens(userClaim);
  const tokensB = contentTokens(projectClaim);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setA = new Set(tokensA);
  const overlap = tokensB.filter((t) => setA.has(t)).length;
  const minLen = Math.min(tokensA.length, tokensB.length);
  return overlap / minLen >= 0.5;
}

function contentTokens(claim: string): string[] {
  return claim
    .toLowerCase()
    .replace(NEGATION_RE, '')
    .split(/\W+/)
    .filter((w) => w.length > 3);
}

export interface ConflictResolution {
  suppressedCandidateIds: string[];
  instructionLines: string[];
}

/**
 * Concern F — resolve user-style ↔ project-convention conflicts.
 *
 *   personal_workflow user style WINS  → suppress the conflicting project
 *     candidate and surface "Following your personal workflow: ..." in the
 *     pack instruction.
 *   coding_preference user style YIELDS → suppress the user candidate and
 *     surface "Project convention: ... Your usual preference '...' is parked
 *     for this codebase." in the pack instruction.
 *
 * The resolver is conservative: only directly contradictory pairs are touched.
 * Non-conflicting user-style atoms pass through to the regular ranking path.
 */
export function resolveStyleConflicts(candidates: RankedCandidate[]): ConflictResolution {
  const suppressedSet = new Set<string>();
  const lines: string[] = [];

  type WithMeta = RankedCandidate & {
    metadata?: {
      userStyleAtomId?: string;
      userStylePriority?: 'personal_workflow' | 'coding_preference';
    };
  };

  const cast = candidates as WithMeta[];
  const userStyleCandidates = cast.filter((c) => c.source === 'userStyle' && c.metadata?.userStyleAtomId);
  // A "project convention" in this context is any non-user-style candidate with
  // a title we can read. The intent is to compare claims, so we look at title.
  const projectCandidates = cast.filter((c) => c.source !== 'userStyle' && (c.title?.length ?? 0) > 0);

  for (const user of userStyleCandidates) {
    for (const proj of projectCandidates) {
      if (!isContradiction(user.title ?? '', proj.title ?? '')) continue;
      const priority = user.metadata?.userStylePriority;
      if (priority === 'personal_workflow') {
        suppressedSet.add(proj.knowledgeId);
        lines.push(`Following your personal workflow: ${user.title}`);
      } else {
        suppressedSet.add(user.knowledgeId);
        lines.push(
          `Project convention: ${proj.title}. Your usual preference "${user.title}" is parked for this codebase.`,
        );
      }
    }
  }

  return {
    suppressedCandidateIds: [...suppressedSet],
    instructionLines: dedupe(lines),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
