# Long-Prompt Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a new preprocessing stage before `classifyQuery` that routes by prompt length, runs a deterministic structural signal sweep over medium+long prompts, optionally extracts a focused primary intent (and sub-tasks) for long prompts via an LLM seam, and gates the continuation-provenance walker so it only runs on short/medium single-task prompts.

**Architecture:** New `src/retrieval/preprocessor.ts` orchestrator. New helpers: `signal-sweep.ts` (scored, capped extraction), `anchor-window.ts` (densest-signal slice for the hash provider). `ModelProvider` grows an optional `extractPromptIntent` method with cache-backed `LlmIntentExtractor`. Output is a `PreprocessedInput` (extends `ContextSearchInput` with a `promptPreprocessing` block). `classifyQuery` is taught to honor pre-swept signals when present. All thresholds live in `retrieval-policy.json`.

**Tech Stack:** TypeScript (Node 22), `node:test` runner with `tsx`, Redis cache (already in repo), existing `ModelProvider` abstraction.

**Spec:** [`docs/superpowers/specs/2026-05-26-long-prompt-preprocessing-design.md`](../specs/2026-05-26-long-prompt-preprocessing-design.md)

**Depends on:** none — concerns B and D are independent. Can ship before, alongside, or after them.

---

## File Structure

**Create:**
- `src/retrieval/preprocessor.ts` — orchestrator (`preprocessLongPrompt`)
- `src/retrieval/signal-sweep.ts` — `sweepSignals`, `scoreSignal`, caps + minScore
- `src/retrieval/anchor-window.ts` — `pickAnchorWindow`
- `src/retrieval/llm-intent.ts` — `LlmIntentExtractor` with Redis cache
- `src/types/preprocessor.ts` — `PreprocessedInput`, `ScoredSignal`, `LengthClass`, `EmbeddingSource`
- `test/preprocessor-signal-sweep.test.ts`
- `test/preprocessor-anchor-window.test.ts`
- `test/preprocessor-intent.test.ts`
- `test/preprocessor-integration.test.ts`

**Modify:**
- `src/types.ts` — re-export new preprocessor types
- `src/retrieval/policy.ts` — add `promptPreprocessing` policy block + defaults
- `src/retrieval/classifier.ts` — honor `PreprocessedInput.promptPreprocessing.structuralSignals` when present
- `src/retrieval/service.ts` — call `preprocessLongPrompt` after redact; gate `addContinuationProvenance`; surface preprocessing in pack
- `src/model/provider.ts` — add `extractPromptIntent?` to `ModelProvider`; `HashModelProvider` does not implement it; OpenAI + Ollama do
- `src/retrieval/context-pack.ts` — pass preprocessing through to `ContextPack.classified.preprocessing` and `taskBrief.followUpSearches`
- `src/mcp/server.ts` — update `tuberosa_search_context` description; append `instruction` when sub-tasks present
- `eval/retrieval-fixtures.json` — long/medium/cap/continuation-gating fixtures
- `eval/retrieval.ts` — runner support for long-prompt fixtures (if needed)
- `config/retrieval-policy.json` — ship default thresholds

---

## Task 1: Types and policy defaults

**Files:**
- Create: `src/types/preprocessor.ts`
- Modify: `src/types.ts`
- Modify: `src/retrieval/policy.ts`
- Modify: `config/retrieval-policy.json` (if it ships as JSON in this repo; if it's embedded in `policy.ts`, edit there instead)

- [ ] **Step 1: Create the types file**

Create `src/types/preprocessor.ts`:

```typescript
import type { ContextSearchInput, TaskType } from '../types.js';

export type LengthClass = 'short' | 'medium' | 'long';
export type EmbeddingSource = 'original' | 'primary_intent' | 'anchor_window';
export type SignalReason = 'frequency' | 'code_block' | 'imperative_proximity' | 'cwd_match';

export interface ScoredSignal {
  value: string;
  score: number;                       // 0..1
  reasons: SignalReason[];
}

export interface StructuralSignals {
  files:         ScoredSignal[];
  symbols:       ScoredSignal[];
  errors:        ScoredSignal[];
  technologies:  ScoredSignal[];
  businessAreas: ScoredSignal[];
}

export interface PromptIntentVerdict {
  primary: string;
  subTasks: string[];
  detectedTaskType?: TaskType;
  detectedTechnologies?: string[];
  confidence: number;
}

export interface PromptPreprocessingResult {
  lengthClass: LengthClass;
  originalTokenEstimate: number;
  embeddingSource: EmbeddingSource;
  primaryIntent?: string;
  subTasks?: string[];
  structuralSignals: StructuralSignals;
  continuationGated: boolean;
  cacheHits: { intent: boolean; signals: boolean };
}

export interface PreprocessedInput extends ContextSearchInput {
  promptPreprocessing?: PromptPreprocessingResult;
}
```

- [ ] **Step 2: Re-export from `src/types.ts`**

Append:

```typescript
export * from './types/preprocessor.js';
```

- [ ] **Step 3: Add policy block**

Edit `src/retrieval/policy.ts`. Add to `DEFAULT_POLICY`:

```typescript
  promptPreprocessing: {
    thresholds: { medium: 800, long: 6000 },
    intent: {
      enabled: true,                   // honored only when provider supports it
      cacheTtlSeconds: 7 * 24 * 60 * 60,
    },
    signalSweep: {
      minScore: 0.25,
      caps: { files: 10, symbols: 12, errors: 6, technologies: 6, businessAreas: 4 },
      cacheTtlSeconds: 60 * 60,
      imperativeVerbs: [
        'update','refactor','fix','add','remove','rename','migrate',
        'verify','port','delete','reorder','simplify','split','extract',
      ],
      proximityTokens: 10,
      codeBlockBonus: 0.30,
      imperativeBonus: 0.20,
      cwdMatchBonus: 0.20,
    },
    anchorWindow: { tokens: 1500 },
  },
```

Extend the `RetrievalPolicy` TS type with the matching shape. Whatever is the existing `DEFAULT_POLICY` source of truth in this file is what's edited.

- [ ] **Step 4: Verify typecheck**

Run: `pnpm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/preprocessor.ts src/types.ts src/retrieval/policy.ts
git commit -m "feat(preprocessor): types and policy defaults for long-prompt handling"
```

---

## Task 2: Structural signal sweep

**Files:**
- Create: `src/retrieval/signal-sweep.ts`
- Test: `test/preprocessor-signal-sweep.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/preprocessor-signal-sweep.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sweepSignals, scoreSignalReasons } from '../src/retrieval/signal-sweep.js';

test('sweepSignals: extracts file paths from prose and code blocks', () => {
  const prompt = 'Refactor src/retrieval/fusion.ts and also fix src/retrieval/policy.ts.\n```\n// see src/retrieval/policy.ts\n```';
  const out = sweepSignals(prompt);
  const paths = out.files.map((f) => f.value).sort();
  assert.deepEqual(paths, ['src/retrieval/fusion.ts','src/retrieval/policy.ts']);
});

test('sweepSignals: capitalized-camel symbols are extracted; common words are not', () => {
  const prompt = 'The PaywallSelectionModal calls fuseCandidates after RankCandidates returns.';
  const symbols = sweepSignals(prompt).symbols.map((s) => s.value);
  assert.ok(symbols.includes('PaywallSelectionModal'));
  assert.ok(symbols.includes('fuseCandidates'));
  assert.ok(!symbols.includes('The'));
});

test('sweepSignals: applies code_block bonus and frequency saturation', () => {
  const prompt = '```\nupdate src/x.ts\n```\nThen update src/x.ts again. Then update src/x.ts again.';
  const file = sweepSignals(prompt).files.find((f) => f.value === 'src/x.ts')!;
  assert.ok(file);
  assert.ok(file.reasons.includes('code_block'));
  assert.ok(file.reasons.includes('frequency'));
  assert.ok(file.reasons.includes('imperative_proximity'));
});

test('sweepSignals: caps files to 10 even when 50 distinct paths appear', () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    lines.push(`update src/file_${i}.ts`);
  }
  const out = sweepSignals(lines.join('\n'));
  assert.equal(out.files.length, 10);
});

test('sweepSignals: drops signals below minScore (single unprefixed mention)', () => {
  const prompt = 'There is a thing called fooBar somewhere in passing context here.';
  const symbols = sweepSignals(prompt).symbols;
  // Single mention, no code block, no imperative proximity → below 0.25
  assert.equal(symbols.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-signal-sweep.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sweepSignals`**

Create `src/retrieval/signal-sweep.ts`:

```typescript
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRetrievalPolicy } from './policy.js';
import type { ScoredSignal, SignalReason, StructuralSignals } from '../types/preprocessor.js';

const FILE_PATH_REGEX = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g;
const SYMBOL_REGEX = /\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z][A-Za-z0-9]*)+\b|\b[a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g;
const ERROR_REGEX = /\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b|\bE[A-Z][A-Z0-9_]+\b|\b(?:TS|ERR)[-_]?\d{3,6}\b/g;
const TECH_HINTS = ['postgres', 'redis', 'pgvector', 'docker', 'react', 'node', 'typescript', 'pnpm', 'ollama', 'openai'];

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function logSaturated(count: number): number {
  // 1 mention → ~0.3, 2 → ~0.55, 3 → ~0.7, saturates near 1 by ~8 mentions.
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
  if (opts.inCodeBlock)   { score += policy.codeBlockBonus;   reasons.push('code_block'); }
  if (opts.imperativeNearby) { score += policy.imperativeBonus; reasons.push('imperative_proximity'); }
  if (opts.cwdMatches)    { score += policy.cwdMatchBonus;    reasons.push('cwd_match'); }
  return { score: clamp01(score), reasons };
}

interface MatchOccurrence { value: string; index: number; }

function collect(regex: RegExp, prompt: string): MatchOccurrence[] {
  const out: MatchOccurrence[] = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
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
  // Imperative proximity uses chars; ~5 chars/token average for code.
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

  const files   = buildScoredSignals(collect(FILE_PATH_REGEX, prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, true);
  const symbols = buildScoredSignals(collect(SYMBOL_REGEX,   prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, false);
  const errors  = buildScoredSignals(collect(ERROR_REGEX,    prompt), prompt, ranges, policy.imperativeVerbs, policy.proximityTokens, cwd, false);

  const techMentions: MatchOccurrence[] = [];
  for (const t of TECH_HINTS) {
    const re = new RegExp(`\\b${t}\\b`, 'gi');
    for (let m = re.exec(prompt); m; m = re.exec(prompt)) techMentions.push({ value: t, index: m.index });
  }
  const technologies = buildScoredSignals(techMentions, prompt, ranges, policy.imperativeVerbs, policy.proximityTokens);

  return capAndDrop({
    files, symbols, errors, technologies, businessAreas: [],
  });
}

function capAndDrop(raw: StructuralSignals): StructuralSignals {
  const policy = getRetrievalPolicy().promptPreprocessing.signalSweep;
  const pick = (arr: ScoredSignal[], cap: number) =>
    arr.filter((s) => s.score >= policy.minScore)
       .sort((a, b) => b.score - a.score)
       .slice(0, cap);
  return {
    files:         pick(raw.files,         policy.caps.files),
    symbols:       pick(raw.symbols,       policy.caps.symbols),
    errors:        pick(raw.errors,        policy.caps.errors),
    technologies:  pick(raw.technologies,  policy.caps.technologies),
    businessAreas: pick(raw.businessAreas, policy.caps.businessAreas),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-signal-sweep.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/signal-sweep.ts test/preprocessor-signal-sweep.test.ts
git commit -m "feat(preprocessor): structural signal sweep with scored caps"
```

---

## Task 3: Anchor-window fallback for hash provider

**Files:**
- Create: `src/retrieval/anchor-window.ts`
- Test: `test/preprocessor-anchor-window.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/preprocessor-anchor-window.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickAnchorWindow } from '../src/retrieval/anchor-window.js';

test('pickAnchorWindow: selects the densest window over uniform noise', () => {
  const noise = 'lorem ipsum dolor sit amet '.repeat(400);
  const dense = '\nupdate src/retrieval/fusion.ts. The PaywallSelectionModal failed with TS2304.\n';
  const prompt = noise + dense + noise;
  const w = pickAnchorWindow(prompt, 200);
  assert.ok(w.text.includes('fusion.ts'));
});

test('pickAnchorWindow: small prompts return the whole prompt as the window', () => {
  const prompt = 'tiny';
  const w = pickAnchorWindow(prompt, 1500);
  assert.equal(w.text, prompt);
  assert.equal(w.start, 0);
  assert.equal(w.end, prompt.length);
});

test('pickAnchorWindow: result is deterministic for the same input', () => {
  const prompt = 'a'.repeat(5000) + ' update src/x.ts ' + 'b'.repeat(5000);
  const a = pickAnchorWindow(prompt, 500);
  const b = pickAnchorWindow(prompt, 500);
  assert.equal(a.start, b.start);
  assert.equal(a.end, b.end);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-anchor-window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pickAnchorWindow`**

Create `src/retrieval/anchor-window.ts`:

```typescript
const TOKEN_CHARS = 4; // existing estimator: ~4 chars/token

const SIGNAL_REGEXES: RegExp[] = [
  /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+/g,
  /\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g,
  /\b(?:update|refactor|fix|add|remove|rename|migrate|verify)\b/gi,
];

export interface AnchorWindow { start: number; end: number; text: string; }

export function pickAnchorWindow(prompt: string, windowTokens: number = 1500): AnchorWindow {
  const windowChars = windowTokens * TOKEN_CHARS;
  if (prompt.length <= windowChars) {
    return { start: 0, end: prompt.length, text: prompt };
  }
  // Score each window position by signal density. Slide in coarse steps to keep cost bounded.
  const step = Math.max(64, Math.floor(windowChars / 8));
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + windowChars <= prompt.length; start += step) {
    const slice = prompt.slice(start, start + windowChars);
    let score = 0;
    for (const re of SIGNAL_REGEXES) {
      score += (slice.match(re) ?? []).length;
    }
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  const end = bestStart + windowChars;
  return { start: bestStart, end, text: prompt.slice(bestStart, end) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-anchor-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/anchor-window.ts test/preprocessor-anchor-window.test.ts
git commit -m "feat(preprocessor): anchor-window fallback for hash provider"
```

---

## Task 4: `ModelProvider.extractPromptIntent` + cached `LlmIntentExtractor`

**Files:**
- Modify: `src/model/provider.ts`
- Create: `src/retrieval/llm-intent.ts`
- Test: `test/preprocessor-intent.test.ts`

- [ ] **Step 1: Add the optional method to `ModelProvider`**

Edit `src/model/provider.ts`:

```typescript
  extractPromptIntent?(input: {
    prompt: string;
    cwd?: string;
    files?: string[];
    symbols?: string[];
  }): Promise<{
    primary: string;
    subTasks: string[];
    detectedTaskType?: 'debugging'|'implementation'|'refactor'|'review'|'planning'|'exploration'|'testing'|'unknown';
    detectedTechnologies?: string[];
    confidence: number;
  }>;
```

`HashModelProvider` leaves this undefined. For OpenAI/Ollama, implement a structured-output call using the JSON schema from spec §6. Match the existing `rewriteQuery` and `judgeAtomUtility` pattern in the file.

- [ ] **Step 2: Write the failing test**

Create `test/preprocessor-intent.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { LlmIntentExtractor } from '../src/retrieval/llm-intent.js';
import type { ModelProvider } from '../src/model/provider.js';

function provider(verdict: { primary: string; subTasks: string[]; confidence: number }): ModelProvider {
  return ({ extractPromptIntent: async () => verdict } as unknown) as ModelProvider;
}

test('LlmIntentExtractor.extract: returns verdict and caches by prompt hash', async () => {
  let calls = 0;
  const cache = new MemoryCache();
  const p = ({
    extractPromptIntent: async () => { calls += 1; return { primary: 'Do X.', subTasks: ['Do Y.'], confidence: 0.9 }; },
  } as unknown) as ModelProvider;
  const x = new LlmIntentExtractor(p, cache);
  const a = await x.extract({ prompt: 'big prompt body' });
  const b = await x.extract({ prompt: 'big prompt body' });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('LlmIntentExtractor.extract: returns undefined when provider lacks the method', async () => {
  const cache = new MemoryCache();
  const x = new LlmIntentExtractor({} as ModelProvider, cache);
  assert.equal(await x.extract({ prompt: 'p' }), undefined);
});

test('LlmIntentExtractor.extract: different prompts produce different cache keys', async () => {
  let calls = 0;
  const cache = new MemoryCache();
  const p = ({
    extractPromptIntent: async () => { calls += 1; return { primary: 'a', subTasks: [], confidence: 1 }; },
  } as unknown) as ModelProvider;
  const x = new LlmIntentExtractor(p, cache);
  await x.extract({ prompt: 'p1' });
  await x.extract({ prompt: 'p2' });
  assert.equal(calls, 2);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `LlmIntentExtractor`**

Create `src/retrieval/llm-intent.ts`:

```typescript
import { createHash } from 'node:crypto';
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import { getRetrievalPolicy } from './policy.js';
import type { PromptIntentVerdict } from '../types/preprocessor.js';

export class LlmIntentExtractor {
  constructor(
    private readonly models: ModelProvider,
    private readonly cache: Cache,
  ) {}

  async extract(input: { prompt: string; cwd?: string; files?: string[]; symbols?: string[] }): Promise<(PromptIntentVerdict & { cacheHit: boolean }) | undefined> {
    if (!this.models.extractPromptIntent) return undefined;
    const ttl = getRetrievalPolicy().promptPreprocessing.intent.cacheTtlSeconds;
    const key = `prompt_intent:${createHash('sha256').update(input.prompt).digest('hex')}`;
    const cached = await this.cache.getJson<PromptIntentVerdict>(key);
    if (cached) return { ...cached, cacheHit: true };
    const verdict = await this.models.extractPromptIntent(input);
    await this.cache.setJson(key, verdict, ttl);
    return { ...verdict, cacheHit: false };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-intent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/provider.ts src/retrieval/llm-intent.ts test/preprocessor-intent.test.ts
git commit -m "feat(preprocessor): extractPromptIntent seam + cached LlmIntentExtractor"
```

---

## Task 5: Preprocessor orchestrator

**Files:**
- Create: `src/retrieval/preprocessor.ts`
- Test: `test/preprocessor-integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/preprocessor-integration.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { preprocessLongPrompt } from '../src/retrieval/preprocessor.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import type { ModelProvider } from '../src/model/provider.js';

function withPolicy(work: () => Promise<void>) {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  return work();
}

test('preprocessLongPrompt: short prompts pass through with lengthClass=short and no preprocessing block', () => withPolicy(async () => {
  const out = await preprocessLongPrompt({ prompt: 'fix the bug' }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'short');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'original');
  assert.equal(out.prompt, 'fix the bug');
}));

test('preprocessLongPrompt: medium prompts get structural sweep, no LLM, original prompt for embedding', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts and fix src/retrieval/policy.ts'.repeat(60);  // ~3-4k tokens
  const out = await preprocessLongPrompt({ prompt: body }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'medium');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'original');
  assert.ok((out.promptPreprocessing?.structuralSignals.files.length ?? 0) > 0);
  assert.equal(out.promptPreprocessing?.subTasks, undefined);
}));

test('preprocessLongPrompt: long prompts with no LLM provider use anchor_window fallback', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);   // > 6k tokens
  const out = await preprocessLongPrompt({ prompt: body }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'long');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'anchor_window');
  assert.ok(out.prompt.length < body.length, 'prompt must be truncated to anchor window');
}));

test('preprocessLongPrompt: long prompts with an intent-capable provider use primary_intent', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const intentProvider: ModelProvider = ({
    extractPromptIntent: async () => ({
      primary: 'Refactor fusion weights.',
      subTasks: ['Run retrieval eval.'],
      confidence: 0.9,
    }),
  } as unknown) as ModelProvider;
  const out = await preprocessLongPrompt({ prompt: body }, intentProvider, new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'long');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'primary_intent');
  assert.equal(out.prompt, 'Refactor fusion weights.');
  assert.deepEqual(out.promptPreprocessing?.subTasks, ['Run retrieval eval.']);
}));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preprocessLongPrompt`**

Create `src/retrieval/preprocessor.ts`:

```typescript
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { ContextSearchInput } from '../types.js';
import type { PreprocessedInput, LengthClass, EmbeddingSource } from '../types/preprocessor.js';
import { getRetrievalPolicy } from './policy.js';
import { sweepSignals } from './signal-sweep.js';
import { pickAnchorWindow } from './anchor-window.js';
import { LlmIntentExtractor } from './llm-intent.js';

const TOKEN_CHARS = 4;

function estimateTokens(s: string): number { return Math.ceil(s.length / TOKEN_CHARS); }

function classifyLength(tokens: number): LengthClass {
  const t = getRetrievalPolicy().promptPreprocessing.thresholds;
  if (tokens <= t.medium) return 'short';
  if (tokens <= t.long)   return 'medium';
  return 'long';
}

export async function preprocessLongPrompt(
  input: ContextSearchInput,
  models: ModelProvider,
  cache: Cache,
): Promise<PreprocessedInput> {
  const tokens = estimateTokens(input.prompt);
  const lengthClass = classifyLength(tokens);

  if (lengthClass === 'short') {
    return {
      ...input,
      promptPreprocessing: {
        lengthClass,
        originalTokenEstimate: tokens,
        embeddingSource: 'original',
        structuralSignals: { files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
        continuationGated: false,
        cacheHits: { intent: false, signals: false },
      },
    };
  }

  const structuralSignals = sweepSignals(input.prompt, input.cwd);

  if (lengthClass === 'medium') {
    return {
      ...input,
      promptPreprocessing: {
        lengthClass,
        originalTokenEstimate: tokens,
        embeddingSource: 'original',
        structuralSignals,
        continuationGated: false,
        cacheHits: { intent: false, signals: false },
      },
    };
  }

  // long
  const intentExtractor = new LlmIntentExtractor(models, cache);
  const intent = await intentExtractor.extract({
    prompt: input.prompt,
    cwd: input.cwd,
    files: input.files,
    symbols: input.symbols,
  });

  let embeddingSource: EmbeddingSource;
  let prompt: string;
  let primaryIntent: string | undefined;
  let subTasks: string[] | undefined;

  if (intent) {
    embeddingSource = 'primary_intent';
    prompt = intent.primary;
    primaryIntent = intent.primary;
    subTasks = intent.subTasks;
  } else {
    embeddingSource = 'anchor_window';
    const window = pickAnchorWindow(input.prompt, getRetrievalPolicy().promptPreprocessing.anchorWindow.tokens);
    prompt = window.text;
  }

  // Continuation walker is always gated for long prompts (per spec §7).
  return {
    ...input,
    prompt,
    promptPreprocessing: {
      lengthClass,
      originalTokenEstimate: tokens,
      embeddingSource,
      primaryIntent,
      subTasks,
      structuralSignals,
      continuationGated: true,
      cacheHits: {
        intent: intent?.cacheHit ?? false,
        signals: false,
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/preprocessor.ts test/preprocessor-integration.test.ts
git commit -m "feat(preprocessor): orchestrator with length routing + intent/anchor fallback"
```

---

## Task 6: Wire preprocessor into `RetrievalService.searchContext`

**Files:**
- Modify: `src/retrieval/service.ts`
- Test: extend `test/preprocessor-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `test/preprocessor-integration.test.ts`:

```typescript
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { defaultConfig } from '../src/config.js';

test('searchContext: long prompts get promptPreprocessing in classified', () => withPolicy(async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.equal(pack.classified.preprocessing?.lengthClass, 'long');
  assert.equal(pack.classified.preprocessing?.embeddingSource, 'anchor_window');
}));

test('searchContext: continuation walker is gated for long prompts even with continuation phrase', () => withPolicy(async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());
  const body = 'continue where we left off. ' + 'update src/retrieval/fusion.ts. '.repeat(2000);
  // Seed a session to make sure walker WOULD have fired
  await store.createAgentSession({ project: 'tuberosa', prompt: 'previous session' });
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.equal(pack.classified.preprocessing?.continuationGated, true);
}));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: FAIL — preprocessor not yet wired into searchContext.

- [ ] **Step 3: Wire it in**

Edit `src/retrieval/service.ts`. After `redactSearchInput` and before `addContinuationProvenance`, call the preprocessor. Pass the resulting `PreprocessedInput` through. Skip `addContinuationProvenance` when `promptPreprocessing.lengthClass === 'long'`.

```typescript
import { preprocessLongPrompt } from './preprocessor.js';

// inside searchContext, replace the redact + normalize block:
const redacted = redactSearchInput(input, this.safety);
const preprocessed = await preprocessLongPrompt(redacted, this.models, this.cache);
const normalized = await this.addContinuationProvenanceMaybe(
  normalizeSearchInput(preprocessed, this.config),
);
```

Add a helper that respects the gate:

```typescript
private async addContinuationProvenanceMaybe(input: NormalizedContextSearchInput & { promptPreprocessing?: PromptPreprocessingResult }): Promise<NormalizedContextSearchInput> {
  if (input.promptPreprocessing?.lengthClass === 'long') return input;
  if ((input.promptPreprocessing?.subTasks?.length ?? 0) > 1) return input;
  return this.addContinuationProvenance(input);
}
```

In the buildContextPack call, propagate `promptPreprocessing` into the pack via `classified.preprocessing`:

```typescript
// Build context-pack helper change in context-pack.ts:
classified: {
  ...input.classified,
  preprocessing: input.input.promptPreprocessing,
},
```

(The exact assignment spot is `assembleContextPack` in `src/retrieval/context-pack.ts`. Pass `promptPreprocessing` through the builder input and attach to `classified`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 5: Run the full retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — short-prompt path is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/service.ts src/retrieval/context-pack.ts test/preprocessor-integration.test.ts
git commit -m "feat(preprocessor): integrate into RetrievalService + gate continuation walker"
```

---

## Task 7: Teach classifier to honor preprocessed signals

**Files:**
- Modify: `src/retrieval/classifier.ts`
- Test: append to `test/preprocessor-integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/preprocessor-integration.test.ts`:

```typescript
test('classifier: when preprocessing.structuralSignals are present, classified.symbols is capped to swept top-K', () => withPolicy(async () => {
  // Construct a prompt with 200 distinct symbols, no code blocks
  const symbols = Array.from({ length: 200 }, (_, i) => `MyClass${i.toString().padStart(3, '0')}`);
  const body = `update src/x.ts. ` + symbols.map((s) => `Mention of ${s}.`).join(' ').repeat(20);
  const store = new MemoryKnowledgeStore();
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), defaultConfig());
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.ok(pack.classified.symbols.length <= 12, `expected <=12, got ${pack.classified.symbols.length}`);
}));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: FAIL — classifier still emits 200 symbols.

- [ ] **Step 3: Make `classifyQuery` honor pre-swept signals**

Edit `src/retrieval/classifier.ts`. Where `classifyQuery` builds `files`/`symbols`/`errors`/`technologies`/`businessAreas`, check `input.promptPreprocessing?.structuralSignals` first:

```typescript
function takeSwept(signals?: ScoredSignal[]): string[] {
  return (signals ?? []).map((s) => s.value);
}

// at the top of classifyQuery, where the regex-derived arrays are built:
const swept = input.promptPreprocessing?.structuralSignals;
const files        = swept ? takeSwept(swept.files)        : extractFiles(input.prompt);
const symbols      = swept ? takeSwept(swept.symbols)      : extractSymbols(input.prompt);
const errors       = swept ? takeSwept(swept.errors)       : extractErrors(input.prompt);
const technologies = swept ? takeSwept(swept.technologies) : extractTechnologies(input.prompt);
const businessAreas = swept ? takeSwept(swept.businessAreas) : extractBusinessAreas(input.prompt);
```

(Use the actual extractor function names from `classifier.ts`. The override is a single conditional per signal type.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/classifier.ts test/preprocessor-integration.test.ts
git commit -m "feat(preprocessor): classifier honors pre-swept structural signals"
```

---

## Task 8: Surface sub-tasks in pack `taskBrief` and MCP response

**Files:**
- Modify: `src/retrieval/context-pack.ts`
- Modify: `src/mcp/server.ts`
- Test: append to `test/preprocessor-integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test('pack: taskBrief.followUpSearches mirrors subTasks for long prompts', () => withPolicy(async () => {
  const intentProvider: ModelProvider = ({
    extractPromptIntent: async () => ({
      primary: 'Refactor fusion.',
      subTasks: ['Add tests.', 'Update docs/foo.md.'],
      confidence: 0.85,
    }),
  } as unknown) as ModelProvider;
  const store = new MemoryKnowledgeStore();
  const service = new RetrievalService(store, new MemoryCache(), intentProvider, defaultConfig());
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.deepEqual(pack.taskBrief.followUpSearches, ['Add tests.', 'Update docs/foo.md.']);
}));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: FAIL — `followUpSearches` not populated.

- [ ] **Step 3: Pass sub-tasks through `assembleContextPack` into `taskBrief`**

Edit `src/retrieval/context-pack.ts`. In `buildTaskBrief`, populate `followUpSearches`:

```typescript
taskBrief: {
  ...existing,
  followUpSearches: input.promptPreprocessing?.subTasks,
}
```

Extend the `TaskBrief` type with an optional `followUpSearches?: string[]` field in the shared types.

- [ ] **Step 4: Update MCP `tuberosa_search_context` description**

Edit `src/mcp/server.ts`. In the tool registration for `tuberosa_search_context`, append to the description:

> For prompts > 6000 tokens, the response includes `subTasks` you can pass back to `tuberosa_search_context` as separate searches when you reach those steps.

When the result has `followUpSearches?.length > 0`, append to the result `instruction` (or add one if absent):

```typescript
if ((pack.taskBrief.followUpSearches?.length ?? 0) > 0) {
  result.instruction = (result.instruction ? result.instruction + '\n' : '')
    + `Detected ${pack.taskBrief.followUpSearches!.length} follow-up tasks. Call tuberosa_search_context again with each sub-task when you start that step.`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/preprocessor-integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/context-pack.ts src/mcp/server.ts src/types.ts test/preprocessor-integration.test.ts
git commit -m "feat(preprocessor): surface subTasks as taskBrief.followUpSearches + MCP instruction"
```

---

## Task 9: Eval fixtures

**Files:**
- Modify: `eval/retrieval-fixtures.json`
- Modify: `eval/retrieval.ts` (runner) if needed

- [ ] **Step 1: Add fixture cases**

Append to `eval/retrieval-fixtures.json`:

```jsonc
{
  "name": "preprocessing: 12k-token prompt with hash provider uses anchor_window",
  "synth": { "promptTokens": 12000, "seed": "update src/retrieval/fusion.ts" },
  "query": { "prompt": "__synth__" },
  "expect": {
    "classified.preprocessing.lengthClass": "long",
    "classified.preprocessing.embeddingSource": "anchor_window"
  }
},
{
  "name": "preprocessing: medium prompt caps symbols to ≤ 12",
  "synth": { "promptTokens": 3500, "seedSymbols": 200 },
  "query": { "prompt": "__synth__" },
  "expect": { "classified.symbols.length.lte": 12 }
},
{
  "name": "preprocessing: long prompt with continuation phrase is NOT walked",
  "synth": { "promptTokens": 7000, "leading": "continue where we left off. " },
  "query": { "prompt": "__synth__" },
  "expect": { "classified.preprocessing.continuationGated": true }
}
```

If `eval/retrieval.ts` does not currently understand `synth`/dotted-path `expect`, extend the runner minimally. Locate the existing assertion loop and add support for dotted accessors plus `.length.lte`/`.eq` predicates.

- [ ] **Step 2: Run the eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — all original cases plus the new ones.

- [ ] **Step 3: Commit**

```bash
git add eval/retrieval-fixtures.json eval/retrieval.ts
git commit -m "test(preprocessor): eval fixtures for length classes, caps, continuation gating"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full unit suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — hitRate=1, staleRejectionRate=1, classification rates at 1.

- [ ] **Step 3: Agent-context eval**

Run: `pnpm run eval:agent-context`
Expected: PASS.

- [ ] **Step 4: Integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [ ] **Step 5: Smoke-test a long prompt against the live server**

```bash
docker compose up --build -d
sleep 5
curl -s -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d "$(node -e 'const body = "update src/retrieval/fusion.ts. ".repeat(2000); console.log(JSON.stringify({project: "tuberosa", prompt: body}))')" \
  | jq '.classified.preprocessing'
```
Expected: JSON shows `lengthClass: "long"` with either `primary_intent` (if OpenAI configured) or `anchor_window` (default hash).

- [ ] **Step 6: Commit any final touch-ups**

```bash
git add -A
git commit -m "test(preprocessor): green eval suite after concern A"
```

---

## Follow-up (deferred, intentionally not in this plan)

- **Real tokenizer (tiktoken).** Current `chars/4` estimator misroutes pathological prompts (CJK, dense code). Swapping in tiktoken is a small change once a Node-friendly wasm build is pinned.
- **Auto fan-out.** Running the pipeline for each sub-task in parallel and merging into one pack. Useful when sub-tasks are tightly coupled; not on the critical path.
- **Cross-call sub-task tracking** — Tuberosa remembering "agent ran sub-task 1, sub-task 2 is next." Belongs in agent-session lifecycle, not the preprocessor.
- **Per-project tunable signal scoring weights.** Defaults ship in `retrieval-policy.json`; per-project overrides come once we have observability data to justify them.
- **`tuberosa_preprocess_prompt` standalone MCP tool** so agents can inspect what the preprocessor would do without committing to a search. Trivial wrapper around `preprocessLongPrompt` once it exists.
