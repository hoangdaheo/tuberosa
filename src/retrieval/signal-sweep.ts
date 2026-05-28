import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRetrievalPolicy } from './policy.js';
import type { ScoredSignal, SignalReason, StructuralSignals } from '../types/preprocessor.js';

const FILE_PATH_REGEX = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g;
const SYMBOL_REGEX = /\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z][A-Za-z0-9]*)+\b|\b[a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g;
const ERROR_REGEX = /\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b|\bE[A-Z][A-Z0-9_]+\b|\b(?:TS|ERR)[-_]?\d{3,6}\b/g;
// Kept in sync with classifier.ts `TECHNOLOGY_TERMS` / `BUSINESS_HINTS` — the
// classifier uses sweep output verbatim for long prompts, so coverage gaps
// here become silent retrieval regressions.
const TECH_HINTS = [
  'typescript', 'javascript', 'react', 'next', 'node', 'postgres', 'pgvector',
  'redis', 'docker', 'mcp', 'graphql', 'rest', 'python', 'go', 'rust', 'aws',
  'lambda', 'serverless', 'pnpm', 'ollama', 'openai',
];
const BUSINESS_HINTS = [
  'auth', 'login', 'billing', 'newsletter', 'paywall', 'subscription', 'search',
  'ads', 'profile', 'publishing', 'content', 'analytics', 'notification',
];

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function logSaturated(count: number): number {
  return clamp01(Math.log1p(count) / Math.log(9));
}

function fencedRanges(prompt: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /```[\s\S]*?```|`[^`\n]+`/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function inAnyRange(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

function nearImperativeVerb(prompt: string, idx: number, verbs: string[], windowChars: number): boolean {
  const start = Math.max(0, idx - windowChars);
  const end = Math.min(prompt.length, idx + windowChars);
  const window = prompt.slice(start, end).toLowerCase();
  return verbs.some((v) => new RegExp(`\\b${v}\\b`).test(window));
}

export function scoreSignalReasons(opts: {
  count: number;
  inCodeBlock: boolean;
  imperativeNearby: boolean;
  cwdMatches: boolean;
}): { score: number; reasons: SignalReason[] } {
  const policy = getRetrievalPolicy().promptPreprocessing.signalSweep;
  const reasons: SignalReason[] = [];
  let score = logSaturated(opts.count);
  if (opts.count > 0) reasons.push('frequency');
  if (opts.inCodeBlock) { score += policy.codeBlockBonus; reasons.push('code_block'); }
  if (opts.imperativeNearby) { score += policy.imperativeBonus; reasons.push('imperative_proximity'); }
  if (opts.cwdMatches) { score += policy.cwdMatchBonus; reasons.push('cwd_match'); }
  return { score: clamp01(score), reasons };
}

interface MatchOccurrence { value: string; index: number }

function collect(regex: RegExp, prompt: string): MatchOccurrence[] {
  const out: MatchOccurrence[] = [];
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const re = new RegExp(regex.source, flags);
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) out.push({ value: m[0], index: m.index });
  return out;
}

function buildScoredSignals(
  occurrences: MatchOccurrence[],
  prompt: string,
  ranges: Array<[number, number]>,
  imperativeVerbs: string[],
  proximityTokens: number,
  cwd?: string,
  resolveCwd: boolean = false,
): ScoredSignal[] {
  const windowChars = proximityTokens * 5;
  const buckets = new Map<string, MatchOccurrence[]>();
  for (const o of occurrences) {
    const list = buckets.get(o.value) ?? [];
    list.push(o);
    buckets.set(o.value, list);
  }
  const out: ScoredSignal[] = [];
  for (const [value, occs] of buckets.entries()) {
    const inCodeBlock = occs.some((o) => inAnyRange(o.index, ranges));
    const imperativeNearby = occs.some((o) => nearImperativeVerb(prompt, o.index, imperativeVerbs, windowChars));
    const cwdMatches = resolveCwd && cwd ? existsSync(resolve(cwd, value)) : false;
    const { score, reasons } = scoreSignalReasons({ count: occs.length, inCodeBlock, imperativeNearby, cwdMatches });
    out.push({ value, score, reasons });
  }
  return out;
}

export function sweepSignals(prompt: string, cwd?: string): StructuralSignals {
  const policy = getRetrievalPolicy().promptPreprocessing.signalSweep;
  const ranges = fencedRanges(prompt);

  const files = buildScoredSignals(collect(FILE_PATH_REGEX, prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, true);
  const symbols = buildScoredSignals(collect(SYMBOL_REGEX, prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, false);
  const errors = buildScoredSignals(collect(ERROR_REGEX, prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, false);

  const technologies = bucketedHintSignals(TECH_HINTS, prompt, ranges, policy.imperativeVerbs, policy.proximityTokens);
  const businessAreas = bucketedHintSignals(BUSINESS_HINTS, prompt, ranges, policy.imperativeVerbs, policy.proximityTokens);

  return capAndDrop({ files, symbols, errors, technologies, businessAreas });
}

function bucketedHintSignals(
  hints: string[],
  prompt: string,
  ranges: Array<[number, number]>,
  imperativeVerbs: string[],
  proximityTokens: number,
): ScoredSignal[] {
  const mentions: MatchOccurrence[] = [];
  for (const t of hints) {
    const re = new RegExp(`\\b${t}\\b`, 'gi');
    for (let m = re.exec(prompt); m; m = re.exec(prompt)) mentions.push({ value: t, index: m.index });
  }
  return buildScoredSignals(mentions, prompt, ranges, imperativeVerbs, proximityTokens);
}

function hasAnchoringReason(reasons: SignalReason[]): boolean {
  return reasons.includes('code_block') || reasons.includes('imperative_proximity') || reasons.includes('cwd_match');
}

function capAndDrop(raw: StructuralSignals): StructuralSignals {
  const policy = getRetrievalPolicy().promptPreprocessing.signalSweep;
  // For free-form value categories (files / symbols / errors) a lone mention
  // with no anchor (code block, imperative proximity, cwd match) is too weak —
  // it's incidental prose. For bounded-list categories (technologies,
  // businessAreas) the value space is already small and curated, so single
  // mentions count and the anchor-reason filter does not apply.
  const pickFreeForm = (arr: ScoredSignal[], cap: number): ScoredSignal[] => arr
    .filter((s) => s.score >= policy.minScore && hasAnchoringReason(s.reasons))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
  const pickBounded = (arr: ScoredSignal[], cap: number): ScoredSignal[] => arr
    .filter((s) => s.score >= policy.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
  return {
    files: pickFreeForm(raw.files, policy.caps.files),
    symbols: pickFreeForm(raw.symbols, policy.caps.symbols),
    errors: pickFreeForm(raw.errors, policy.caps.errors),
    technologies: pickBounded(raw.technologies, policy.caps.technologies),
    businessAreas: pickBounded(raw.businessAreas, policy.caps.businessAreas),
  };
}
