import type { KnowledgeAtomInput } from '../types/atoms.js';

/**
 * Stage 1 of the write gate (Concern D). Deterministic stop-list that rejects
 * well-formed-but-useless atoms — one-time event announcements (test runs,
 * commits, doc/rename announcements) and atoms too sparse or untriggered to ever
 * help a future agent. Runs before the schema floor so the cheapest, most certain
 * rejections happen first.
 */
export interface TrivialityRule {
  name: string;
  test: (atom: KnowledgeAtomInput) => boolean;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'was', 'and', 'or', 'for', 'with', 'as', 'at', 'by',
]);

/** Lowercased words longer than two characters with stop-words removed. */
export function contentWords(claim: string): string[] {
  return claim
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export const DEFAULT_TRIVIALITY_RULES: TrivialityRule[] = [
  {
    name: 'test_result',
    test: (a) => /^(ran|run|executed|all)\s.*(passed|completed|succeeded|green|ok)\b/i.test(a.claim),
  },
  {
    name: 'doc_update_announcement',
    test: (a) => /^updated?\s+\S+\.(md|json|yaml|yml|txt|toml)\b/i.test(a.claim),
  },
  {
    name: 'commit_status',
    test: (a) => /^(committed?|pushed?|merged?|shipped?|deployed?)\b/i.test(a.claim),
  },
  {
    name: 'rename_announcement',
    test: (a) => /^(refactored|renamed|moved|added|removed)\s+[A-Za-z0-9_]+\.?$/i.test(a.claim.trim()),
  },
  {
    name: 'no_concrete_trigger',
    test: (a) => !(
      (a.trigger.errors?.length ?? 0)
      || (a.trigger.files?.length ?? 0)
      || (a.trigger.symbols?.length ?? 0)
    ),
  },
  {
    name: 'sparse_claim',
    test: (a) => contentWords(a.claim).length < 5,
  },
];

export interface TrivialityResult {
  ok: boolean;
  matched: string[];
  marginContentWords: number; // surfaced for the stage-4 borderline check
}

export function evaluateTriviality(
  atom: KnowledgeAtomInput,
  rules: TrivialityRule[] = DEFAULT_TRIVIALITY_RULES,
): TrivialityResult {
  const matched = rules.filter((rule) => rule.test(atom)).map((rule) => rule.name);
  return {
    ok: matched.length === 0,
    matched,
    marginContentWords: contentWords(atom.claim).length,
  };
}
