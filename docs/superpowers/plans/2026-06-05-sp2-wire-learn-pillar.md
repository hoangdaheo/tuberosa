# SP2 — Wire the LEARN Pillar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real model providers (OpenAI + Ollama) produce knowledge atoms from finished sessions, so the already-built atoms → curation → conventions → retrieval loop comes alive.

**Architecture:** One shared module holds the extraction prompt, JSON schema, and parser. OpenAI gets a thin `extractAtoms` using its existing `/v1/responses` structured-output helper. A new `OllamaGenerationProvider` (separate from the rerank-only provider) calls `/api/chat` with a JSON-schema `format`. `ProviderRegistry` passes `extractAtoms`/`judgeAtomUtility` through **only when configured**, so the extractor's capability check stays honest.

**Tech Stack:** TypeScript (Node 22.21.1), node:test, tsx. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-05-sp2-wire-learn-pillar-design.md`
**Branch:** `sp2-wire-learn-pillar` (already created). Owner pushes; never push.

**Global rules for every task:**
- Run pnpm with: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH` prefix if `node -v` < 22. One pnpm command at a time.
- Commit **specific files only** — never `git add -A` or `git add .`.
- No `Co-Authored-By: Claude` trailer.
- Never write to stdout in MCP-path code; stderr only.
- Run a single test file with: `PATH=...:$PATH node --test --import tsx test/<file>.test.ts`

**Plan note (spec deviation, intentional):** the spec mentioned a new `eval:knowledge-completeness` fixture "proving extraction wiring". That eval only ingests knowledge items and measures retrieval coverage — it never calls `finish_session`, so it *cannot* exercise extraction. The deterministic end-to-end proof lives in unit tests instead (Tasks 4–5); the eval suites run unchanged as regression gates (Task 6).

---

### Task 1: Shared extraction module — `src/model/atom-extraction.ts`

The single source of truth for atom-extraction + atom-utility prompts, schemas, and parsers. Both providers use it; only transport differs.

**Files:**
- Create: `src/model/atom-extraction.ts`
- Test: `test/atom-extraction.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/atom-extraction.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ATOM_EXTRACTION_SYSTEM_PROMPT,
  ATOM_UTILITY_SYSTEM_PROMPT,
  atomExtractionSchema,
  atomUtilitySchema,
  parseAtomUtilityVerdict,
  parseExtractedAtoms,
} from '../src/model/atom-extraction.js';
import { ModelProviderError } from '../src/errors.js';

const VALID_ATOM = {
  claim: 'Run pnpm run eval:retrieval before changing fusion weights.',
  type: 'convention',
  evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
  trigger: { files: ['src/retrieval/fusion.ts'], taskTypes: ['refactor'] },
  verification: { command: 'pnpm run eval:retrieval' },
  pitfalls: ['Do not lower eval thresholds to make tests pass.'],
};

test('prompt names the atom contract', () => {
  assert.ok(ATOM_EXTRACTION_SYSTEM_PROMPT.includes('generalizable'));
  assert.ok(ATOM_EXTRACTION_SYSTEM_PROMPT.includes('240'));
  assert.ok(ATOM_UTILITY_SYSTEM_PROMPT.includes('generalizable'));
});

test('schemas have an object root (required by OpenAI strict + Ollama format)', () => {
  assert.equal(atomExtractionSchema().type, 'object');
  assert.equal(atomUtilitySchema().type, 'object');
});

test('parseExtractedAtoms keeps a fully valid atom', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({ atoms: [VALID_ATOM] }));
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.type, 'convention');
  assert.deepEqual(atoms[0]!.evidence, [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }]);
  assert.equal(atoms[0]!.verification?.command, 'pnpm run eval:retrieval');
});

test('parseExtractedAtoms drops invalid entries without failing the batch', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({
    atoms: [
      VALID_ATOM,
      { claim: '', type: 'fact', evidence: [], trigger: {} },          // empty claim
      { claim: 'Bad type survives nothing.', type: 'opinion', evidence: [], trigger: {} }, // bad type
      'not-an-object',
    ],
  }));
  assert.equal(atoms.length, 1);
});

test('parseExtractedAtoms strips nulls and malformed evidence, keeps valid kinds', () => {
  const atoms = parseExtractedAtoms(JSON.stringify({
    atoms: [{
      claim: 'Evidence entries are validated per kind.',
      type: 'fact',
      evidence: [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'file' },                            // missing path -> dropped
        { kind: 'commit', sha: 'abc123' },
        { kind: 'teleport', uri: 'x' },              // unknown kind -> dropped
        null,
      ],
      trigger: { errors: ['E1', null, 7], files: null },
      verification: null,
      pitfalls: null,
    }],
  }));
  assert.equal(atoms.length, 1);
  assert.deepEqual(atoms[0]!.evidence, [
    { kind: 'file', path: 'src/a.ts' },
    { kind: 'commit', sha: 'abc123' },
  ]);
  assert.deepEqual(atoms[0]!.trigger.errors, ['E1']);
  assert.equal(atoms[0]!.verification, undefined);
  assert.equal(atoms[0]!.pitfalls, undefined);
});

test('parseExtractedAtoms clamps claim length to 240 and caps at 8 atoms', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...VALID_ATOM,
    claim: `Atom number ${i} ${'x'.repeat(300)}`,
  }));
  const atoms = parseExtractedAtoms(JSON.stringify({ atoms: many }));
  assert.equal(atoms.length, 8);
  assert.ok(atoms[0]!.claim.length <= 240);
});

test('parseExtractedAtoms throws ModelProviderError on non-JSON', () => {
  assert.throws(() => parseExtractedAtoms('not json'), ModelProviderError);
});

test('parseExtractedAtoms returns [] when atoms key is missing', () => {
  assert.deepEqual(parseExtractedAtoms('{}'), []);
});

test('parseAtomUtilityVerdict normalizes fields', () => {
  const verdict = parseAtomUtilityVerdict(JSON.stringify({
    generalizable: true,
    reason: 'r'.repeat(500),
    confidence: 1.7,
  }));
  assert.equal(verdict.generalizable, true);
  assert.ok(verdict.reason.length <= 200);
  assert.equal(verdict.confidence, 1);
});

test('parseAtomUtilityVerdict throws ModelProviderError on non-JSON', () => {
  assert.throws(() => parseAtomUtilityVerdict('nope'), ModelProviderError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx test/atom-extraction.test.ts`
Expected: FAIL — cannot find module `../src/model/atom-extraction.js`.

- [ ] **Step 3: Implement the module**

Create `src/model/atom-extraction.ts`:

```ts
import { ModelProviderError } from '../errors.js';
import { clamp, truncate } from '../util/text.js';
import type { ExtractedAtomCandidate } from './provider.js';

/**
 * SP2 — single source of truth for atom-extraction and atom-utility LLM
 * calls. Both OpenAiModelProvider (/v1/responses) and OllamaGenerationProvider
 * (/api/chat) use the same prompts, schemas, and parsers so atom quality
 * semantics never drift between providers; only the transport differs.
 */

const MAX_ATOMS = 8;
const MAX_CLAIM_LENGTH = 240; // matches the critic floor (src/atoms/critic.ts)
const ATOM_TYPES = ['fact', 'procedure', 'decision', 'gotcha', 'convention'] as const;

export const ATOM_EXTRACTION_SYSTEM_PROMPT = [
  'You extract reusable engineering lessons ("atoms") from a finished coding-agent session.',
  `Return at most ${MAX_ATOMS} atoms. Fewer, higher-value atoms beat many weak ones.`,
  'Return an empty list when the session contains nothing generalizable.',
  'Each atom must be a lesson a FUTURE agent can apply to a similar but different task —',
  'not a status update, not a restatement of the session prompt, not one-time trivia.',
  `claim: one concrete, self-contained sentence, max ${MAX_CLAIM_LENGTH} characters.`,
  'type: fact | procedure | decision | gotcha | convention.',
  'evidence: at least one concrete reference (file path, commit sha, test, url, or prior session).',
  'trigger: signals that should surface this atom later (errors, files, symbols, taskTypes, intentTags).',
  'verification: optional command or assertion that proves the claim still holds.',
  'pitfalls: optional list of mistakes to avoid.',
  'Preserve exact file paths, symbols, and error tokens verbatim.',
  'Return JSON only.',
].join(' ');

export const ATOM_UTILITY_SYSTEM_PROMPT = [
  'You audit a candidate engineering lesson for a coding-agent memory.',
  'Decide if it is generalizable — i.e. would help a future agent on a similar but different task.',
  'Reject if it merely describes one-time events (test runs, commits, status updates) or restates trivia.',
  'Return JSON only: { "generalizable": bool, "reason": string, "confidence": 0..1 }.',
].join(' ');

/**
 * Root is an object (not a bare array): OpenAI strict mode and Ollama's
 * `format` both require an object root. Optional fields are nullable +
 * required, which is what OpenAI strict mode demands; the parser strips nulls.
 */
export function atomExtractionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      atoms: {
        type: 'array',
        maxItems: MAX_ATOMS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim: { type: 'string' },
            type: { type: 'string', enum: [...ATOM_TYPES] },
            evidence: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['file', 'commit', 'test', 'url', 'prior_session'] },
                  path: { type: ['string', 'null'] },
                  sha: { type: ['string', 'null'] },
                  uri: { type: ['string', 'null'] },
                  testName: { type: ['string', 'null'] },
                  sessionId: { type: ['string', 'null'] },
                },
                required: ['kind', 'path', 'sha', 'uri', 'testName', 'sessionId'],
              },
            },
            trigger: {
              type: 'object',
              additionalProperties: false,
              properties: {
                errors: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                files: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                symbols: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                taskTypes: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 },
                intentTags: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 },
              },
              required: ['errors', 'files', 'symbols', 'taskTypes', 'intentTags'],
            },
            verification: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: {
                command: { type: ['string', 'null'] },
                assertion: { type: ['string', 'null'] },
              },
              required: ['command', 'assertion'],
            },
            pitfalls: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
          },
          required: ['claim', 'type', 'evidence', 'trigger', 'verification', 'pitfalls'],
        },
      },
    },
    required: ['atoms'],
  };
}

export function atomUtilitySchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      generalizable: { type: 'boolean' },
      reason: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['generalizable', 'reason', 'confidence'],
  };
}

/**
 * Parses + normalizes a model response into ExtractedAtomCandidate[].
 * Invalid entries are dropped individually (a partially-bad batch still
 * yields its good atoms). Policy checks (evidence required, triviality,
 * dedup) belong to the AtomCritic, not here — shape only.
 */
export function parseExtractedAtoms(text: string): ExtractedAtomCandidate[] {
  const parsed = parseJsonObject(text, 'Atom extraction response');
  const entries = Array.isArray(parsed.atoms) ? parsed.atoms : [];
  const atoms: ExtractedAtomCandidate[] = [];
  for (const entry of entries) {
    if (atoms.length >= MAX_ATOMS) break;
    const atom = normalizeAtom(entry);
    if (atom) atoms.push(atom);
  }
  return atoms;
}

export function parseAtomUtilityVerdict(
  text: string,
): { generalizable: boolean; reason: string; confidence: number } {
  const parsed = parseJsonObject(text, 'Atom utility response');
  return {
    generalizable: parsed.generalizable === true,
    reason: typeof parsed.reason === 'string' ? truncate(parsed.reason, 200) : '',
    confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : 0,
  };
}

function normalizeAtom(entry: unknown): ExtractedAtomCandidate | undefined {
  if (!isRecord(entry)) return undefined;
  const claim = typeof entry.claim === 'string' ? truncate(entry.claim, MAX_CLAIM_LENGTH).trim() : '';
  if (!claim) return undefined;
  const type = ATOM_TYPES.find((t) => t === entry.type);
  if (!type) return undefined;

  const atom: ExtractedAtomCandidate = {
    claim,
    type,
    evidence: normalizeEvidence(entry.evidence),
    trigger: normalizeTrigger(entry.trigger),
  };
  const verification = normalizeVerification(entry.verification);
  if (verification) atom.verification = verification;
  const pitfalls = stringArray(entry.pitfalls, 6);
  if (pitfalls.length > 0) atom.pitfalls = pitfalls;
  return atom;
}

function normalizeEvidence(value: unknown): ExtractedAtomCandidate['evidence'] {
  if (!Array.isArray(value)) return [];
  const evidence: ExtractedAtomCandidate['evidence'] = [];
  for (const entry of value.slice(0, 6)) {
    if (!isRecord(entry)) continue;
    if (entry.kind === 'file' && typeof entry.path === 'string' && entry.path.trim()) {
      evidence.push({ kind: 'file', path: entry.path.trim() });
    } else if (entry.kind === 'commit' && typeof entry.sha === 'string' && entry.sha.trim()) {
      evidence.push({ kind: 'commit', sha: entry.sha.trim() });
    } else if (
      entry.kind === 'test'
      && typeof entry.path === 'string' && entry.path.trim()
      && typeof entry.testName === 'string' && entry.testName.trim()
    ) {
      evidence.push({ kind: 'test', path: entry.path.trim(), testName: entry.testName.trim() });
    } else if (entry.kind === 'url' && typeof entry.uri === 'string' && entry.uri.trim()) {
      evidence.push({ kind: 'url', uri: entry.uri.trim(), fetchedAt: new Date().toISOString() });
    } else if (entry.kind === 'prior_session' && typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
      evidence.push({ kind: 'prior_session', sessionId: entry.sessionId.trim() });
    }
  }
  return evidence;
}

function normalizeTrigger(value: unknown): ExtractedAtomCandidate['trigger'] {
  if (!isRecord(value)) return {};
  const trigger: ExtractedAtomCandidate['trigger'] = {};
  const errors = stringArray(value.errors, 6);
  const files = stringArray(value.files, 6);
  const symbols = stringArray(value.symbols, 6);
  const taskTypes = stringArray(value.taskTypes, 4);
  const intentTags = stringArray(value.intentTags, 4);
  if (errors.length) trigger.errors = errors;
  if (files.length) trigger.files = files;
  if (symbols.length) trigger.symbols = symbols;
  if (taskTypes.length) trigger.taskTypes = taskTypes;
  if (intentTags.length) trigger.intentTags = intentTags;
  return trigger;
}

function normalizeVerification(value: unknown): ExtractedAtomCandidate['verification'] | undefined {
  if (!isRecord(value)) return undefined;
  const verification: NonNullable<ExtractedAtomCandidate['verification']> = {};
  if (typeof value.command === 'string' && value.command.trim()) verification.command = truncate(value.command, 300).trim();
  if (typeof value.assertion === 'string' && value.assertion.trim()) verification.assertion = truncate(value.assertion, 300).trim();
  return verification.command || verification.assertion ? verification : undefined;
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncate(item, 200).trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseJsonObject(value: string, description: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new ModelProviderError(`${description} was not a JSON object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx test/atom-extraction.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/model/atom-extraction.ts test/atom-extraction.test.ts
git commit -m "feat(sp2): shared atom-extraction prompt, schema, and parser"
```

---

### Task 2: Config — `ollamaExtractModel` + env docs

**Files:**
- Modify: `src/config.ts` (type ~line 29, loader ~line 135)
- Modify: `docs/MINIMAL_ENV.md`
- Modify: `.env.example` (only if it exists — check first with `ls .env.example`)

- [ ] **Step 1: Add the type field**

In `src/config.ts`, after `ollamaRerankModel?: string;` (~line 28) add:

```ts
    /** SP2 — Ollama generation model for atom extraction + LLM critic. Unset = extraction off. */
    ollamaExtractModel?: string;
```

- [ ] **Step 2: Add the loader line**

After `ollamaRerankModel: process.env.TUBEROSA_OLLAMA_RERANK_MODEL || undefined,` (~line 134) add:

```ts
      ollamaExtractModel: process.env.TUBEROSA_OLLAMA_EXTRACT_MODEL || undefined,
```

- [ ] **Step 3: Document in `docs/MINIMAL_ENV.md`**

Read the file first; add one row/line in the ollama section following its existing format, saying:
`TUBEROSA_OLLAMA_EXTRACT_MODEL` — optional. Generation model for the LEARN pillar (atom extraction + LLM critic), e.g. `qwen3.5:latest`. Unset = atom extraction disabled (FIND still works). Under `openai`, extraction uses `OPENAI_RERANK_MODEL` instead.

- [ ] **Step 4: Build to verify**

Run: `pnpm run build`
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts docs/MINIMAL_ENV.md
git commit -m "feat(sp2): TUBEROSA_OLLAMA_EXTRACT_MODEL config for atom extraction"
```

---

### Task 3: OpenAI — `extractAtoms` + reuse shared utility prompt/schema

**Files:**
- Modify: `src/model/provider.ts` (add `extractAtoms` after `judgeAtomUtility` ~line 282; replace local `ATOM_UTILITY_SYSTEM_PROMPT`/`atomUtilitySchema` with imports; refactor `judgeAtomUtility` parse to `parseAtomUtilityVerdict`)
- Test: `test/model-provider.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/model-provider.test.ts`:

```ts
import { OpenAiModelProvider } from '../src/model/provider.js';
import { makeTestConfig } from './support/test-config.js';

function openAiConfig(overrides: Record<string, unknown> = {}) {
  return makeTestConfig({
    model: {
      provider: 'openai',
      embeddingDimensions: 1536,
      openAiEmbeddingModel: 'text-embedding-3-small',
      openAiTimeoutMs: 30_000,
      llmCriticEnabled: false,
      openAiApiKey: 'test-key',
      openAiRerankModel: 'gpt-test',
      ...overrides,
    },
  });
}

test('OpenAI extractAtoms parses structured atoms from /v1/responses', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    requestBody = JSON.parse(init?.body ?? '{}');
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        atoms: [{
          claim: 'Run pnpm run eval:retrieval before fusion changes.',
          type: 'convention',
          evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
          trigger: { files: ['src/retrieval/fusion.ts'] },
        }],
      }),
    }), { status: 200 });
  }) as typeof fetch;

  const provider = new OpenAiModelProvider(openAiConfig());
  const atoms = await provider.extractAtoms({
    project: 'tuberosa',
    sessionPrompt: 'refactor fusion weights',
    summary: 'tuned weights, ran eval',
  });
  equal(atoms.length, 1);
  equal(atoms[0]!.type, 'convention');
  equal((requestBody as { model?: string }).model, 'gpt-test');
});

test('OpenAI extractAtoms returns [] when no rerank model is configured', async () => {
  const provider = new OpenAiModelProvider(openAiConfig({ openAiRerankModel: undefined }));
  deepEqual(await provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }), []);
});
```

(The file already imports `equal`/`deepEqual`/`ok` from `node:assert/strict` and `test` from `node:test`.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test --import tsx test/model-provider.test.ts`
Expected: FAIL — `provider.extractAtoms is not a function`.

- [ ] **Step 3: Implement**

In `src/model/provider.ts`:

a) Add import at top:

```ts
import {
  ATOM_EXTRACTION_SYSTEM_PROMPT,
  ATOM_UTILITY_SYSTEM_PROMPT,
  atomExtractionSchema,
  atomUtilitySchema,
  parseAtomUtilityVerdict,
  parseExtractedAtoms,
} from './atom-extraction.js';
```

b) Delete the now-duplicated local `ATOM_UTILITY_SYSTEM_PROMPT` const (~line 381) and `atomUtilitySchema()` function (~line 388).

c) In `judgeAtomUtility`, replace the manual parse block (the lines building `{ generalizable, reason, confidence }` from `parsed`) with:

```ts
    const outputText = extractOutputText(await response.json());
    if (!outputText) {
      throw new ModelProviderError('OpenAI atom-utility response did not include output text.');
    }
    return parseAtomUtilityVerdict(outputText);
```

d) Add `extractAtoms` directly after `judgeAtomUtility`:

```ts
  async extractAtoms(input: {
    project: string;
    sessionPrompt: string;
    summary?: string;
    changedFiles?: string[];
    decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
    verificationCommands?: string[];
  }): Promise<ExtractedAtomCandidate[]> {
    // SP2 — reuse the structured-output rerank model slot, same as
    // judgeAtomUtility. No model configured -> no atoms (fail-open).
    const model = this.config.model.openAiRerankModel;
    if (!model) {
      return [];
    }

    const response = await fetchOpenAiJson(
      this.config,
      model,
      ATOM_EXTRACTION_SYSTEM_PROMPT,
      'atom_extraction',
      atomExtractionSchema(),
      input,
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`OpenAI atom-extraction request failed: ${response.status} ${detail}`);
    }

    const outputText = extractOutputText(await response.json());
    if (!outputText) {
      throw new ModelProviderError('OpenAI atom-extraction response did not include output text.');
    }
    return parseExtractedAtoms(outputText);
  }
```

- [ ] **Step 4: Run tests + build**

Run: `node --test --import tsx test/model-provider.test.ts` → PASS
Run: `pnpm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/model/provider.ts test/model-provider.test.ts
git commit -m "feat(sp2): extractAtoms on OpenAiModelProvider via shared extraction module"
```

---

### Task 4: `OllamaGenerationProvider` — extract + judge via /api/chat

**Files:**
- Create: `src/model/ollama-generation.ts`
- Test: `test/ollama-generation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/ollama-generation.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OllamaGenerationProvider } from '../src/model/ollama-generation.js';
import { ModelProviderError } from '../src/errors.js';

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response): typeof fetch {
  return (async (url: unknown, init?: { body?: string }) =>
    handler(String(url), JSON.parse(init?.body ?? '{}'))) as typeof fetch;
}

function chatResponse(content: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
}

test('extractAtoms posts to /api/chat with schema format and parses atoms', async () => {
  let captured: { url?: string; body?: Record<string, unknown> } = {};
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    ollamaUrl: 'http://localhost:11434/',
    fetchFn: fakeFetch((url, body) => {
      captured = { url, body };
      return chatResponse({
        atoms: [{
          claim: 'Memory store and postgres store must stay behavior-identical.',
          type: 'convention',
          evidence: [{ kind: 'file', path: 'src/storage/store.ts' }],
          trigger: { files: ['src/storage/memory-store.ts'] },
        }],
      });
    }),
  });

  const atoms = await provider.extractAtoms({ project: 'tuberosa', sessionPrompt: 'fix store parity' });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.type, 'convention');
  assert.equal(captured.url, 'http://localhost:11434/api/chat');
  assert.equal(captured.body!.model, 'qwen3.5:latest');
  assert.equal(captured.body!.stream, false);
  assert.equal((captured.body!.format as { type?: string }).type, 'object');
});

test('judgeAtomUtility parses the verdict', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: fakeFetch(() => chatResponse({ generalizable: false, reason: 'one-time event', confidence: 0.9 })),
  });
  const verdict = await provider.judgeAtomUtility({ claim: 'ran tests once', type: 'fact', trigger: {} });
  assert.equal(verdict.generalizable, false);
  assert.equal(verdict.confidence, 0.9);
});

test('non-200 response throws ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => new Response('boom', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
});

test('missing message content throws ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => new Response(JSON.stringify({ message: {} }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
});

test('network failure is wrapped in ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
  });
  await assert.rejects(
    provider.judgeAtomUtility({ claim: 'c', type: 'fact', trigger: {} }),
    ModelProviderError,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx test/ollama-generation.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `src/model/ollama-generation.ts`:

```ts
import { ModelProviderError } from '../errors.js';
import type { ExtractedAtomCandidate, ModelProvider } from './provider.js';
import {
  ATOM_EXTRACTION_SYSTEM_PROMPT,
  ATOM_UTILITY_SYSTEM_PROMPT,
  atomExtractionSchema,
  atomUtilitySchema,
  parseAtomUtilityVerdict,
  parseExtractedAtoms,
} from './atom-extraction.js';

/**
 * SP2 — Ollama generation provider for the LEARN pillar.
 *
 * Separate from OllamaRerankProvider: the rerank model is a cross-encoder
 * that cannot generate text. This provider calls `/api/chat` with a JSON
 * schema `format` (Ollama structured outputs) using a generation model
 * (TUBEROSA_OLLAMA_EXTRACT_MODEL, e.g. qwen3.5:latest).
 *
 * Failures throw ModelProviderError — there is no meaningful fallback for
 * extraction. AgentSessionService.extractSessionAtoms converts failures into
 * observable knowledge gaps, so session finish never breaks.
 */
export interface OllamaGenerationOptions {
  /** Ollama generation model id (required — the caller gates on config). */
  modelId: string;
  /** Base URL of the Ollama server. Defaults to `http://localhost:11434`. */
  ollamaUrl?: string;
  /** Request timeout. Generation is slow on local models; defaults to 120 000 ms. */
  timeoutMs?: number;
  /** Optional fetch override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120_000;

export class OllamaGenerationProvider implements Pick<ModelProvider, 'extractAtoms' | 'judgeAtomUtility'> {
  readonly name = 'ollama-generation';

  private readonly modelId: string;
  private readonly ollamaUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaGenerationOptions) {
    this.modelId = options.modelId;
    this.ollamaUrl = trimTrailingSlash(options.ollamaUrl ?? DEFAULT_OLLAMA_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async extractAtoms(input: {
    project: string;
    sessionPrompt: string;
    summary?: string;
    changedFiles?: string[];
    decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
    verificationCommands?: string[];
  }): Promise<ExtractedAtomCandidate[]> {
    const content = await this.chatJson(ATOM_EXTRACTION_SYSTEM_PROMPT, input, atomExtractionSchema());
    return parseExtractedAtoms(content);
  }

  async judgeAtomUtility(input: {
    claim: string;
    type: 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] };
  }): Promise<{ generalizable: boolean; reason: string; confidence: number }> {
    const content = await this.chatJson(ATOM_UTILITY_SYSTEM_PROMPT, input, atomUtilitySchema());
    return parseAtomUtilityVerdict(content);
  }

  private async chatJson(systemPrompt: string, input: unknown, schema: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) },
          ],
          format: schema,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ModelProviderError('Ollama generation request failed.', error);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`Ollama generation request failed: ${response.status} ${detail}`);
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ModelProviderError('Ollama generation response did not include message content.');
    }
    return content;
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx test/ollama-generation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/ollama-generation.ts test/ollama-generation.test.ts
git commit -m "feat(sp2): OllamaGenerationProvider — extractAtoms + judgeAtomUtility via /api/chat"
```

---

### Task 5: Registry passthrough + wiring + deterministic e2e

**Files:**
- Modify: `src/model/registry.ts`
- Test: `test/model-registry.test.ts` (append)
- Test: `test/atoms-finish-session.test.ts` (append one e2e test)

- [ ] **Step 1: Write the failing tests**

Append to `test/model-registry.test.ts`:

```ts
test('registry has NO extractAtoms when extract model is unset (honest capability check)', () => {
  const registry = buildOllamaRegistry(baseConfig({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaRerankModel: 'reranker',
  }));
  ok(registry);
  equal(registry!.extractAtoms, undefined);
  equal(registry!.judgeAtomUtility, undefined);
});

test('registry passes extractAtoms + judgeAtomUtility through when extract model is set', () => {
  const registry = buildOllamaRegistry(baseConfig({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaRerankModel: 'reranker',
    ollamaExtractModel: 'qwen3.5:latest',
  }));
  ok(registry);
  equal(typeof registry!.extractAtoms, 'function');
  equal(typeof registry!.judgeAtomUtility, 'function');
  const description = (registry as ProviderRegistry).describe();
  const capabilities = new Map(description.map((entry) => [entry.capability, entry.providerName]));
  equal(capabilities.get('extractAtoms'), 'ollama-generation');
  equal(capabilities.get('judgeAtomUtility'), 'ollama-generation');
});
```

Append to `test/atoms-finish-session.test.ts` (uses existing imports plus `ProviderRegistry`):

```ts
import { ProviderRegistry } from '../src/model/registry.js';

test('finishSession: extraction works through a ProviderRegistry passthrough', async () => {
  const store = new MemoryKnowledgeStore();
  const hash = new HashModelProvider();
  const registry = new ProviderRegistry(hash);
  registry.registerExtraction('stub-extraction', {
    extractAtoms: async () => [{
      claim: 'Registry passthrough delivers atoms end-to-end.',
      type: 'fact' as const,
      evidence: [{ kind: 'file' as const, path: 'src/model/registry.ts' }],
      trigger: { files: ['src/model/registry.ts'] },
    }],
  });

  const session = await store.createAgentSession({
    prompt: 'verify registry extraction passthrough',
    project: 'tuberosa',
  });
  const cache = new MemoryCache();
  const config = loadConfig();
  const retrieval = new RetrievalService(store, cache, registry, config);
  const ingestion = new IngestionService(store, registry);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, registry, undefined, config);

  await service.finishSession({ sessionId: session.id, outcome: 'completed', summary: 'done' });

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.claim, 'Registry passthrough delivers atoms end-to-end.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx test/model-registry.test.ts`
Expected: FAIL — `registry.registerExtraction is not a function` / capability assertions fail.

- [ ] **Step 3: Implement registry changes**

In `src/model/registry.ts`:

a) Extend the capability type (line 13):

```ts
export type ModelCapability = 'embed' | 'rewriteQuery' | 'rerank' | 'extractAtoms' | 'judgeAtomUtility';
```

b) In `ProviderRegistry`, add optional instance properties and the registration method. The properties are **only assigned when a backing provider supplies them**, so `AtomExtractor`'s `if (!this.models.extractAtoms)` check stays honest:

```ts
export class ProviderRegistry implements ModelProvider {
  /**
   * SP2 — extraction capabilities are instance properties assigned only when
   * a provider supplies them. A registry without an extraction provider has
   * NO extractAtoms property, which is what AtomExtractor's capability
   * check requires.
   */
  extractAtoms?: ModelProvider['extractAtoms'];
  judgeAtomUtility?: ModelProvider['judgeAtomUtility'];

  private readonly entries = new Map<ModelCapability, CapabilityProvider>();
  private readonly extractionEntries: RegistryEntry[] = [];
  private readonly fallback: ModelProvider;

  // ... constructor + register() unchanged ...

  registerExtraction(
    name: string,
    provider: Pick<ModelProvider, 'extractAtoms' | 'judgeAtomUtility'>,
  ): void {
    if (provider.extractAtoms && !this.extractAtoms) {
      this.extractAtoms = provider.extractAtoms.bind(provider);
      this.extractionEntries.push({ capability: 'extractAtoms', providerName: name });
    }
    if (provider.judgeAtomUtility && !this.judgeAtomUtility) {
      this.judgeAtomUtility = provider.judgeAtomUtility.bind(provider);
      this.extractionEntries.push({ capability: 'judgeAtomUtility', providerName: name });
    }
  }

  describe(): RegistryEntry[] {
    return [
      ...[...this.entries.entries()].map(([capability, provider]) => ({
        capability,
        providerName: provider.name,
      })),
      ...this.extractionEntries,
    ];
  }
}
```

c) In `buildOllamaRegistry`, after the reranker registration, add:

```ts
  if (config.model.ollamaExtractModel) {
    registry.registerExtraction('ollama-generation', new OllamaGenerationProvider({
      modelId: config.model.ollamaExtractModel,
      ollamaUrl: config.model.ollamaUrl,
    }));
  } else {
    noteExtractionDisabledOnce();
  }
```

d) Add the one-time stderr note (module scope, follows `OllamaRerankProvider.logFailure`'s silencing pattern — stderr only, never stdout):

```ts
let hasLoggedExtractionDisabled = false;

function noteExtractionDisabledOnce(): void {
  if (hasLoggedExtractionDisabled) return;
  hasLoggedExtractionDisabled = true;
  if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_OLLAMA_PROVIDER === 'true') return;
  process.stderr.write(
    '[tuberosa] atom extraction disabled under ollama; set TUBEROSA_OLLAMA_EXTRACT_MODEL (e.g. qwen3.5:latest) to enable the LEARN pillar.\n',
  );
}
```

e) Add import: `import { OllamaGenerationProvider } from './ollama-generation.js';`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx test/model-registry.test.ts` → PASS
Run: `node --test --import tsx test/atoms-finish-session.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/model/registry.ts test/model-registry.test.ts test/atoms-finish-session.test.ts
git commit -m "feat(sp2): ProviderRegistry extraction passthrough + ollama wiring"
```

---

### Task 6: Full gates

- [ ] **Step 1:** `pnpm run build` → clean.
- [ ] **Step 2:** `pnpm test` → all pass; count ≥ 773 baseline + new tests. Report exact counts.
- [ ] **Step 3:** `pnpm run eval:retrieval` → hitRate=1, staleRejectionRate=1, all exact classification rates=1.
- [ ] **Step 4:** `pnpm run eval:agent-context` → green.
- [ ] **Step 5:** `pnpm run eval:knowledge-completeness` → green (regression only — see plan note).
- [ ] **Step 6:** `docker compose ps` — if the stack is up, run `pnpm run test:integration`; if down, note it was skipped.
- [ ] **Step 7:** `git diff --check` → no whitespace errors. No commit (nothing should have changed).

Known pre-existing failures NOT in scope: `eval:context-mapping` (`paywall-modal-implementation`, `auth-flow-doc-lookup`).

---

### Task 7: Live Ollama loop + critic measurement (decision point)

Validates real extraction quality against the owner's local `qwen3.5:latest`. No DB writes to the owner's Postgres — uses an in-process memory store.

**Files:**
- Create (scratch, NOT committed): `/tmp/sp2-live-check.ts`

- [ ] **Step 1: Confirm Ollama is up**

Run: `curl -s --max-time 3 http://localhost:11434/api/tags | grep -o 'qwen3.5:latest'`
Expected: `qwen3.5:latest`. If down, stop and ask the owner.

- [ ] **Step 2: Write the scratch script**

Create `/tmp/sp2-live-check.ts`:

```ts
/* SP2 live check — real qwen3.5 extraction through the full in-process loop.
 * Memory store only; never touches Postgres. Run from the repo root:
 *   TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=ollama \
 *   TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen3.5:latest npx tsx /tmp/sp2-live-check.ts
 */
import { MemoryKnowledgeStore } from './src/storage/memory-store.js';
import { MemoryCache } from './src/cache.js';
import { loadConfig } from './src/config.js';
import { createModelProvider } from './src/model/factory.js';
import { RetrievalService } from './src/retrieval/service.js';
import { IngestionService } from './src/ingest/service.js';
import { ReflectionService } from './src/reflection/service.js';
import { AgentSessionService } from './src/agent-session/service.js';
import { CurationService } from './src/curation/service.js';

const config = loadConfig();
const store = new MemoryKnowledgeStore();
const cache = new MemoryCache();
const models = createModelProvider(config);
console.log('extractAtoms available:', typeof models.extractAtoms === 'function');

const retrieval = new RetrievalService(store, cache, models, config);
const ingestion = new IngestionService(store, models);
const reflection = new ReflectionService(store, ingestion);
const sessions = new AgentSessionService(store, retrieval, reflection, models, undefined, config, cache);

// 6 realistic session summaries — enough to cross the curation nudge at 5.
const SESSIONS: Array<{ prompt: string; summary: string; changedFiles: string[]; verificationCommands: string[] }> = [
  {
    prompt: 'Fix the memory-store updateKnowledge parity bug',
    summary: 'memory-store.updateKnowledge skipped mergeLabelProvenanceIntoMetadata that postgres-store calls; extracted a shared helper so both stores merge label provenance identically. Lesson: every KnowledgeStore method must behave the same in postgres-store.ts and memory-store.ts.',
    changedFiles: ['src/storage/memory-store.ts', 'src/storage/postgres-store.ts'],
    verificationCommands: ['pnpm test', 'pnpm run test:integration'],
  },
  {
    prompt: 'Slim the MCP contextPackShortlist response',
    summary: 'The MCP search response exceeded token limits because every candidate serialized full content and diagnostics. Bounded inline deep context and trimmed per-item diagnostics at src/mcp/server.ts contextPackShortlist. Lesson: MCP responses must stay under the client token limit; keep full data behind tuberosa_get_context_pack.',
    changedFiles: ['src/mcp/server.ts'],
    verificationCommands: ['pnpm run eval:agent-context'],
  },
  {
    prompt: 'Stop the classifier extracting capitalized verbs as symbols',
    summary: 'classifier.ts treated any capitalized word as a code symbol, so prompt verbs like Simplify became symbols. Added hasSymbolStructure requiring camelCase, dots, or underscores. Lesson: add a failing eval fixture to eval/retrieval-fixtures.json BEFORE changing classifier heuristics.',
    changedFiles: ['src/retrieval/classifier.ts'],
    verificationCommands: ['pnpm run eval:retrieval'],
  },
  {
    prompt: 'Convert validation.ts to zod schemas',
    summary: 'Replaced 1400 LOC of hand-rolled validators with zod schemas in src/schemas/, keeping the same error mapping in src/errors.ts. Lesson: tool input primitives must keep the 2M-char and 4096-array caps; new tool inputs follow the zod pattern in src/schemas/.',
    changedFiles: ['src/validation.ts', 'src/schemas/context.ts'],
    verificationCommands: ['pnpm test', 'pnpm run build'],
  },
  {
    prompt: 'Fix worktree uuid leak into ::uuid casts',
    summary: 'Synthetic worktree:<sha> ids leaked into SQL ::uuid casts breaking search from a checkout. Filtered synthetic ids before the CTE. Lesson: worktree:<sha> knowledge ids are synthetic and must never reach Postgres uuid columns.',
    changedFiles: ['src/storage/postgres-store.ts'],
    verificationCommands: ['pnpm run test:integration'],
  },
  {
    prompt: 'Debounce the physical mirror writes',
    summary: 'Mirror wrote on every store mutation, hammering disk. Added a debounce (TUBEROSA_PHYSICAL_MIRROR debounceMs). Lesson: .tuberosa/current mirror writes are debounced; tests asserting mirror files must wait past the debounce window.',
    changedFiles: ['src/operations/physical-mirror.ts'],
    verificationCommands: ['pnpm test'],
  },
];

let lastNudge: unknown;
for (const [i, s] of SESSIONS.entries()) {
  const session = await store.createAgentSession({ prompt: s.prompt, project: 'tuberosa' });
  const t0 = Date.now();
  const result = await sessions.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: s.summary,
    changedFiles: s.changedFiles,
    verificationCommands: s.verificationCommands,
  });
  lastNudge = result.curationNudge;
  console.log(`session ${i + 1}/${SESSIONS.length} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s; nudge:`, result.curationNudge?.count ?? 'none');
}

const atoms = await store.listAtoms({ project: 'tuberosa', status: 'active', limit: 100 });
console.log(`\n=== ${atoms.length} atoms stored ===`);
for (const a of atoms) console.log(`- [${a.type}] ${a.claim}`);

const gaps = await store.listKnowledgeGaps({ project: 'tuberosa', limit: 100 });
console.log(`\n=== ${gaps.length} knowledge gaps (rejections/failures) ===`);
for (const g of gaps) console.log(`- ${g.reason}`);

const events = await store.listAtomGateEvents({ project: 'tuberosa', limit: 200 });
const byStageOutcome = new Map<string, number>();
for (const e of events) {
  const key = `${e.stage}:${e.outcome}`;
  byStageOutcome.set(key, (byStageOutcome.get(key) ?? 0) + 1);
}
console.log('\n=== gate events by stage:outcome ===');
for (const [k, v] of byStageOutcome) console.log(`- ${k}: ${v}`);

console.log('\n=== curation nudge after last session ===', lastNudge);
const curation = new CurationService(store);
const proposal = await curation.proposeCuration({ project: 'tuberosa' });
console.log(`\n=== ${proposal.clusters.length} curation cluster(s) ===`);
console.log(proposal.instruction);
```

Note: if `store.listAtomGateEvents` has a different name, check `src/storage/store.ts` for the gate-event list method and adjust — but do NOT change src code for the script's sake.

- [ ] **Step 3: Run it**

Run from repo root:
```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=ollama TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen3.5:latest npx tsx /tmp/sp2-live-check.ts
```
Expected: `extractAtoms available: true`; ≥1 atom per session for most sessions; nudge fires once ≥5 un-curated atoms accumulate; ≥1 curation cluster proposed at the end (clusters need ≥2 related atoms).

- [ ] **Step 4: STOP — report to owner (critic decision point)**

Report: atoms stored (with claims), rejection reasons, gate stage:outcome counts, latency per session. Then decide WITH the owner:
- If real atoms pass and junk is rejected → no critic changes; work item 4 closes as "measured, no tuning needed".
- If real atoms are wrongly rejected → propose the specific rule change, write a failing test/fixture FIRST, then change. (Constraint: never loosen anything to make a number look better.)

- [ ] **Step 5: Owner env enablement**

After owner sign-off, append to `/home/nash/tuberosa/.env` under the ollama block:

```
TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen3.5:latest
```

Then tell the owner to restart/reconnect the Tuberosa MCP server so the broker serves the new code, and (optionally, owner-driven) run one real `tuberosa_finish_session` → `tuberosa_propose_curation` → `tuberosa_reflect` (with `metadata.convention=true`, `evidenceAtomIds`) → approve → confirm the convention appears in `tuberosa_search_context` results and atlas `conventions.md`.

---

### Task 8: Docs + handoff + memory updates

**Files:**
- Modify: `docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md` (§5 status, §7 deferred items)
- Modify: `/home/nash/.claude/projects/-home-nash-tuberosa/memory/project-debloat-engagement.md`

- [ ] **Step 1: Update handoff §5** — mark SP2 status (what shipped, commits), and add to §7: dual-persistence unification deferred (owner decision 2026-06-05); `extractPromptIntent` not passed through the registry under ollama/local (long-prompt path, not LEARN).
- [ ] **Step 2: Update the memory file** — SP2 shipped state, branch name, the registry-passthrough discovery, the extract-model env var.
- [ ] **Step 3: Commit (repo files only)**

```bash
git add docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md
git commit -m "docs(sp2): handoff status — LEARN pillar wired"
```

---

## Self-review (done at plan-writing time)

1. **Spec coverage:** §3.1→Task 1, §3.2→Task 3, §3.3→Task 4, §3.4→Task 2, §3.5→Task 5, §3.6→Task 7 step 4, §5 gates→Task 6, live e2e→Task 7, deferred items→Task 8. One intentional deviation (eval fixture → unit e2e) documented in the header note.
2. **Placeholders:** none — every code step has complete code; the one "check method name" note in Task 7 is a guarded verification instruction, not deferred work.
3. **Type consistency:** `registerExtraction(name, provider)` matches between Task 5 impl and tests; `ExtractedAtomCandidate` fields match `src/model/provider.ts:14`; `ollamaExtractModel` consistent across Tasks 2/5; parser exports match Task 1/3/4 imports.
```
