import type { KnowledgeItemType, ReferenceInput } from '../types.js';

export interface ItemTypeInferenceInput {
  content: string;
  metadata?: Record<string, unknown>;
  references?: ReferenceInput[];
  /** Optional hint from upstream code (file extension inference, reflection draft itemType). */
  hint?: KnowledgeItemType;
}

export interface ItemTypeInferenceResult {
  itemType: KnowledgeItemType;
  /** 0..1, higher when concrete signals (references, headings, trigger) drove the decision. */
  confidence: number;
  /** Human-readable reasons recorded in metadata so we can audit catch-all rate trends. */
  reasons: string[];
}

const RULE_HEADING_REGEX = /^\s{0,3}#{1,6}\s+(?:decision|rule|policy|guideline|principle|standard)\b/im;
const RULE_KEYWORD_REGEX = /\b(MUST|SHALL|NEVER|DO NOT|FORBIDDEN|REQUIRED|prohibited)\b/;
const SPEC_HEADING_REGEX = /^\s{0,3}#{1,6}\s+(?:spec|specification|requirements?|design|api contract|schema)\b/im;
const WORKFLOW_HEADING_REGEX = /^\s{0,3}#{1,6}\s+(?:workflow|playbook|runbook|how to|steps|procedure|checklist)\b/im;
const BUGFIX_KEYWORD_REGEX = /\b(?:root cause|repro|regression|fix(?:ed|es)?|stack trace|error code|incident|postmortem|post-mortem)\b/i;
const CONVERSATION_HEADING_REGEX = /^\s{0,3}#{1,6}\s+(?:conversation|chat|transcript|session log)\b/im;

const CODE_FILE_REGEX = /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|sql|sh|yaml|yml|toml|json|tf)$/i;
const TEST_FILE_REGEX = /(?:^|\/)(?:tests?|__tests__)\//i;
const TEST_FILENAME_REGEX = /(?:\.test\.|\.spec\.|_test\.)/i;
const WIKI_FILE_REGEX = /\.(?:md|mdx|rst|adoc)$/i;
const SPEC_FILE_REGEX = /(?:^|\/)(?:specs?|requirements?|design|rfcs?)\//i;

const BUGFIX_TRIGGER_TYPES = new Set(['error_recovery']);

export function inferItemType(input: ItemTypeInferenceInput): ItemTypeInferenceResult {
  const reasons: string[] = [];
  const content = input.content ?? '';
  const metadata = input.metadata ?? {};
  const references = input.references ?? [];

  const trigger = typeof metadata.triggerType === 'string' ? metadata.triggerType : undefined;
  const taxonomy = typeof metadata.taxonomy === 'string' ? metadata.taxonomy : undefined;
  const origin = typeof metadata.source === 'string' ? metadata.source : undefined;

  const testRefs = references.filter((reference) => referencePointsToTest(reference));
  const codeRefs = references.filter((reference) => referencePointsToCode(reference));
  const docRefs = references.filter((reference) => referencePointsToDocs(reference));
  const specRefs = references.filter((reference) => referencePointsToSpec(reference));

  // 1. error-log / error_recovery origin → bugfix
  if (
    origin === 'error_log'
    || origin === 'error_log_finalization'
    || (trigger && BUGFIX_TRIGGER_TYPES.has(trigger))
    || taxonomy === 'incident_lesson'
  ) {
    reasons.push(`trigger:${trigger ?? origin ?? taxonomy} → bugfix`);
    return { itemType: 'bugfix', confidence: 0.92, reasons };
  }

  // 2. .test paths in references → workflow if heading says "how to" / playbook,
  //    bugfix if content mentions root-cause language; otherwise workflow (testing playbook).
  if (testRefs.length > 0) {
    if (BUGFIX_KEYWORD_REGEX.test(content)) {
      reasons.push(`testRefs+bugfix keywords → bugfix`);
      return { itemType: 'bugfix', confidence: 0.78, reasons };
    }
    reasons.push(`testRefs → workflow`);
    return { itemType: 'workflow', confidence: 0.75, reasons };
  }

  // 3. rule/policy/decision heading or imperative MUST/SHALL → rule
  if (RULE_HEADING_REGEX.test(content) || (RULE_KEYWORD_REGEX.test(content) && content.length < 4000)) {
    reasons.push('rule heading or normative language → rule');
    return { itemType: 'rule', confidence: 0.82, reasons };
  }

  // 4. workflow heading / playbook content → workflow
  if (WORKFLOW_HEADING_REGEX.test(content)) {
    reasons.push('workflow heading → workflow');
    return { itemType: 'workflow', confidence: 0.8, reasons };
  }

  // 5. specification heading or /specs|/requirements path → spec
  if (SPEC_HEADING_REGEX.test(content) || specRefs.length > 0) {
    reasons.push('spec heading or spec path → spec');
    return { itemType: 'spec', confidence: 0.78, reasons };
  }

  // 6. code-fence ratio ≥ 40% + source-file references → code_ref
  const codeFenceRatio = computeCodeFenceRatio(content);
  if (codeFenceRatio >= 0.4 && codeRefs.length > 0) {
    reasons.push(`code-fence ratio ${codeFenceRatio.toFixed(2)} + code refs → code_ref`);
    return { itemType: 'code_ref', confidence: 0.86, reasons };
  }

  // 7. conversation-style content / transcript heading → conversation
  if (CONVERSATION_HEADING_REGEX.test(content)) {
    reasons.push('conversation heading → conversation');
    return { itemType: 'conversation', confidence: 0.72, reasons };
  }

  // 8. hint from upstream (file extension inference, draft itemType) when present and non-default
  if (input.hint && input.hint !== 'memory') {
    reasons.push(`fallback to hint:${input.hint}`);
    return { itemType: input.hint, confidence: 0.6, reasons };
  }

  // 9. Final fallback — memory. Tracked by sandbox `itemTypeCatchAllRate`.
  reasons.push('catch-all → memory');
  return { itemType: 'memory', confidence: 0.4, reasons };
}

function computeCodeFenceRatio(content: string): number {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceLines = 0;
  for (const line of lines) {
    if (/^\s{0,3}```/.test(line)) {
      inFence = !inFence;
      fenceLines += 1; // count the fence line itself
      continue;
    }
    if (inFence) {
      fenceLines += 1;
    }
  }
  return lines.length === 0 ? 0 : fenceLines / lines.length;
}

function referencePointsToTest(reference: ReferenceInput): boolean {
  if (reference.type !== 'file') return false;
  return TEST_FILE_REGEX.test(reference.uri) || TEST_FILENAME_REGEX.test(reference.uri);
}

function referencePointsToCode(reference: ReferenceInput): boolean {
  if (reference.type !== 'file') return false;
  if (TEST_FILE_REGEX.test(reference.uri) || TEST_FILENAME_REGEX.test(reference.uri)) return false;
  if (WIKI_FILE_REGEX.test(reference.uri)) return false;
  return CODE_FILE_REGEX.test(reference.uri);
}

function referencePointsToDocs(reference: ReferenceInput): boolean {
  if (reference.type !== 'file') return false;
  return WIKI_FILE_REGEX.test(reference.uri);
}

function referencePointsToSpec(reference: ReferenceInput): boolean {
  if (reference.type !== 'file') return false;
  return SPEC_FILE_REGEX.test(reference.uri);
}
