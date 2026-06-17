# Agent-Delegated Self-Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the calling AI agent the preferred author of self-learned lessons (atoms) via a guided handshake on session finish, with local Ollama atom extraction demoted to an optional fallback for headless runs — so a `local`-provider setup gets real embeddings, real rerank, AND high-quality self-learning with zero Ollama dependency in normal use.

**Architecture:** The atom pipeline (critic → embed → store → graph-link) is already shared. Today only the model-backed `extractAtoms` path feeds it. We (1) refactor `AtomExtractor` so candidate ingestion is callable independently of model extraction, (2) add an MCP tool that lets the agent submit its own atom candidates into that same pipeline, and (3) add a `learningHandoff` block to the `finish_session` response that nudges the agent to reflect and submit when no model extractor is configured. Ollama extraction stays as an opt-in fallback wired into the `local` provider registry.

**Tech Stack:** TypeScript (Node 22, ESM), MCP stdio + HTTP, Postgres/pgvector store, `@xenova/transformers` local embeddings + cross-encoder, Ollama (optional), `node --test` with `tsx`.

## Global Constraints

- **Node version:** `22.21.1` (`.nvmrc`). Prefix commands with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH` if the shell uses an older Node.
- **Retrieval eval must stay green:** `pnpm run eval:retrieval` asserts `hitRate=1`, `staleRejectionRate=1`, all classification rates `1`. Do not adjust thresholds to pass.
- **Agent-context eval must stay green:** `pnpm run eval:agent-context`.
- **MCP stdout is protocol-only:** never add `console.log`/`process.stdout.write` in the MCP code path; diagnostics go to `stderr`.
- **No retrieval heuristic/behavior change without eval coverage first:** every new behavior gets a failing test before code.
- **Response-shape changes must be additive:** `finish_session` gains only new OPTIONAL fields; existing fields (`compliance`, `learningDecision`, `reflectionDraft`, etc.) keep their shape and meaning.
- **Secrets redaction is mandatory:** any agent-submitted atom content flows through `redactAtomInput(..., KnowledgeSafetyService)` before embedding/storage — never store raw submitted text directly.
- **Run impact analysis before editing a symbol:** `gitnexus_impact({target, direction:"upstream"})` for `finishSession`, `extractFromSession`, `buildProviderRegistry`; report HIGH/CRITICAL risk before proceeding.

---

## File Structure

- `src/atoms/extractor.ts` — **modify.** Split the per-candidate ingestion loop out of `extractFromSession` into a reusable `ingestCandidates(...)`. New public surface consumed by the agent-submission path.
- `src/agent-session/service.ts` — **modify.** Add `submitSessionAtoms(...)`; add `learningHandoff` to the finish result when no model extractor + no supplied draft.
- `src/agent-session/types.ts` (or wherever `FinishAgentSessionResult` lives) — **modify.** Add optional `learningHandoff?: LearningHandoff` to the result type.
- `src/validation.ts` — **modify.** Add `validateSubmitSessionAtomsInput(...)` mirroring existing validators.
- `src/mcp/server.ts` — **modify.** Add `tuberosa_submit_session_atoms` dispatch case + advertise it in `tools/list`.
- `src/model/registry.ts` — **modify.** In `buildProviderRegistry` (the `local` path), register `OllamaGenerationProvider` extraction when `TUBEROSA_OLLAMA_EXTRACT_MODEL` is set.
- `test/atoms-extractor.test.ts` — **create/extend.** Cover `ingestCandidates` directly.
- `test/api-boundary.test.ts` — **extend.** Cover the new tool's validation + dispatch.
- `test/agent-session.test.ts` (or the agent-context surface) — **extend.** Cover `learningHandoff` presence/absence.
- `test/model-registry.test.ts` — **extend.** Cover local-embed + ollama-extract composition.
- `.env`, `docs/SETUP_AND_USAGE.md` — **modify.** Config base + documentation.

---

## Task 1: Refactor `AtomExtractor` to expose candidate ingestion

**Files:**
- Modify: `src/atoms/extractor.ts:40-103`
- Test: `test/atoms-extractor.test.ts`

**Interfaces:**
- Consumes: existing `AtomCritic`, `KnowledgeStore`, `ModelProvider` (already injected via constructor at `extractor.ts:31-38`).
- Produces:
  - `ingestCandidates(candidates: ExtractedAtomCandidate[], input: { project: string; sessionId: string }): Promise<ExtractFromSessionResult>` — the per-candidate critic→embed→store→link loop, callable without `models.extractAtoms`.
  - `extractFromSession` keeps its existing signature and now delegates to `ingestCandidates`.

- [ ] **Step 1: Write the failing test**

```ts
// test/atoms-extractor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtomExtractor } from '../src/atoms/extractor.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import type { ExtractedAtomCandidate } from '../src/model/provider.js';

test('ingestCandidates stores agent-supplied atoms without a model extractor', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider(384); // no extractAtoms -> proves model path is not required
  const critic = new AtomCritic(store, models, {});
  const extractor = new AtomExtractor(store, models, critic);

  const candidates: ExtractedAtomCandidate[] = [{
    claim: 'Run pnpm run eval:retrieval before touching fusion weights.',
    type: 'procedure',
    evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
    trigger: { files: ['src/retrieval/fusion.ts'], taskTypes: ['refactor'] },
  }];

  const result = await extractor.ingestCandidates(candidates, {
    project: 'tuberosa',
    sessionId: '11111111-1111-1111-1111-111111111111',
  });

  assert.equal(result.stored.length + result.rejected.length, 1);
  if (result.stored.length === 1) {
    assert.equal(result.stored[0].claim, candidates[0].claim);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/atoms-extractor.test.ts`
Expected: FAIL with `extractor.ingestCandidates is not a function`.

- [ ] **Step 3: Refactor `extractFromSession`; add `ingestCandidates`**

Replace the body of `extractFromSession` (lines 40-103) so the loop lives in a new method:

```ts
  async extractFromSession(input: ExtractFromSessionInput): Promise<ExtractFromSessionResult> {
    if (!this.models.extractAtoms) {
      return { stored: [], rejected: [], queuedLegacyMigrations: [] };
    }
    const candidates = await this.models.extractAtoms({
      project: input.project,
      sessionPrompt: input.sessionPrompt,
      summary: input.summary,
      changedFiles: input.changedFiles,
      decisions: input.decisions,
      verificationCommands: input.verificationCommands,
    });
    return this.ingestCandidates(candidates, { project: input.project, sessionId: input.sessionId });
  }

  /**
   * Run agent- OR model-supplied atom candidates through the shared write gate:
   * redact -> critic -> embed -> store -> semantic-neighbor link. Identical
   * acceptance semantics whether the candidates came from a model extractor or
   * from a calling agent via tuberosa_submit_session_atoms.
   */
  async ingestCandidates(
    candidates: ExtractedAtomCandidate[],
    input: { project: string; sessionId: string },
  ): Promise<ExtractFromSessionResult> {
    const stored: KnowledgeAtom[] = [];
    const rejected: ExtractFromSessionResult['rejected'] = [];
    const queuedLegacyMigrations: string[] = [];

    for (const candidate of candidates) {
      const rawInput: KnowledgeAtomInput = {
        project: input.project,
        claim: candidate.claim,
        type: candidate.type,
        evidence: candidate.evidence as KnowledgeAtomInput['evidence'],
        trigger: candidate.trigger,
        verification: candidate.verification,
        pitfalls: candidate.pitfalls,
        producedBy: 'agent_session',
        producedAtSessionId: input.sessionId,
      };
      const candidateInput = redactAtomInput(rawInput, this.safety);
      const result = await this.critic.evaluate(candidateInput, input.sessionId);
      if (result.outcome === 'accepted' || result.outcome === 'pending') {
        const embedding = await this.models.embed(atomEmbeddingText(candidateInput));
        const created = await this.store.createAtom({ ...candidateInput, embedding });
        if (getRetrievalPolicy().graphInference.enabled) {
          try {
            const links = await inferSemanticNeighbors(created, this.store, this.models);
            if (links.length) {
              await syncAtomLinks(created.id, links, this.store, 'semantic');
            }
          } catch (error) {
            process.stderr.write(
              `[atom-inference] semantic-neighbor failed for ${created.id}: ${(error as Error).message}\n`,
            );
          }
        }
        stored.push((await this.store.getAtom(created.id)) ?? created);
      } else if (result.outcome === 'queue_legacy_migration' && result.legacyKnowledgeIdForMigration) {
        queuedLegacyMigrations.push(result.legacyKnowledgeIdForMigration);
      } else {
        rejected.push({ candidate: candidateInput, reasons: result.reasons });
      }
    }

    return { stored, rejected, queuedLegacyMigrations };
  }
```

Add the import for the candidate type at the top of the file:

```ts
import type { ModelProvider, ExtractedAtomCandidate } from '../model/provider.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/atoms-extractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing atom tests to confirm no regression**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/*atom*.test.ts`
Expected: PASS (extraction behavior is unchanged; only refactored).

- [ ] **Step 6: Commit**

```bash
git add src/atoms/extractor.ts test/atoms-extractor.test.ts
git commit -m "refactor(atoms): extract ingestCandidates from extractFromSession"
```

---

## Task 2: Agent atom submission tool (`tuberosa_submit_session_atoms`)

**Files:**
- Modify: `src/agent-session/service.ts` (add `submitSessionAtoms`)
- Modify: `src/validation.ts` (add `validateSubmitSessionAtomsInput`)
- Modify: `src/mcp/server.ts` (dispatch case + `tools/list` entry)
- Test: `test/api-boundary.test.ts`

**Interfaces:**
- Consumes: `AtomExtractor.ingestCandidates` (Task 1).
- Produces:
  - `AgentSessionService.submitSessionAtoms(input: { sessionId: string; project?: string; atoms: ExtractedAtomCandidate[] }): Promise<ExtractFromSessionResult>`.
  - MCP tool `tuberosa_submit_session_atoms` returning `{ stored, rejected, queuedLegacyMigrations, instruction }`.
  - `validateSubmitSessionAtomsInput(args: unknown): { sessionId: string; project?: string; atoms: ExtractedAtomCandidate[] }`.

- [ ] **Step 1: Write the failing validation + dispatch test**

```ts
// test/api-boundary.test.ts  (add)
test('tuberosa_submit_session_atoms validates and routes agent atoms', async () => {
  const { dispatchTool, startedSessionId } = await setupMcpHarness(); // existing harness helper
  const res = await dispatchTool('tuberosa_submit_session_atoms', {
    sessionId: startedSessionId,
    atoms: [{
      claim: 'Prefer host.docker.internal for container->host Ollama.',
      type: 'gotcha',
      evidence: [{ kind: 'file', path: 'docker-compose.yml' }],
      trigger: { files: ['docker-compose.yml'] },
    }],
  });
  assert.ok('stored' in res || 'rejected' in res);
});

test('tuberosa_submit_session_atoms rejects a missing atoms array', async () => {
  const { dispatchTool, startedSessionId } = await setupMcpHarness();
  await assert.rejects(
    () => dispatchTool('tuberosa_submit_session_atoms', { sessionId: startedSessionId }),
    /atoms/,
  );
});
```

> If `setupMcpHarness`/`dispatchTool` helpers do not exist in this file, mirror the existing pattern used by the nearest `tuberosa_*` dispatch test in `test/api-boundary.test.ts` (construct services with the memory store + hash provider, call `handleMcpRequest`).

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/api-boundary.test.ts`
Expected: FAIL with unknown tool / `validateSubmitSessionAtomsInput is not a function`.

- [ ] **Step 3: Add the validator**

```ts
// src/validation.ts
const ATOM_TYPES = ['fact', 'procedure', 'decision', 'gotcha', 'convention'] as const;
const EVIDENCE_KINDS = ['file', 'commit', 'test', 'url', 'prior_session'] as const;

export function validateSubmitSessionAtomsInput(args: unknown): {
  sessionId: string;
  project?: string;
  atoms: ExtractedAtomCandidate[];
} {
  const record = expectRecord(args, 'tuberosa_submit_session_atoms arguments');
  const sessionId = readRequiredMcpString(record.sessionId, 'arguments.sessionId');
  const project = readOptionalMcpString(record.project, 'arguments.project');
  if (!Array.isArray(record.atoms) || record.atoms.length === 0) {
    throw new ValidationError('tuberosa_submit_session_atoms arguments.atoms must be a non-empty array');
  }
  const atoms = record.atoms.map((raw, i) => {
    const a = expectRecord(raw, `arguments.atoms[${i}]`);
    const claim = readRequiredMcpString(a.claim, `arguments.atoms[${i}].claim`);
    const type = readRequiredMcpString(a.type, `arguments.atoms[${i}].type`);
    if (!ATOM_TYPES.includes(type as (typeof ATOM_TYPES)[number])) {
      throw new ValidationError(`arguments.atoms[${i}].type must be one of ${ATOM_TYPES.join(', ')}`);
    }
    const evidence = Array.isArray(a.evidence) ? a.evidence.map((e, j) => {
      const ev = expectRecord(e, `arguments.atoms[${i}].evidence[${j}]`);
      const kind = readRequiredMcpString(ev.kind, `arguments.atoms[${i}].evidence[${j}].kind`);
      if (!EVIDENCE_KINDS.includes(kind as (typeof EVIDENCE_KINDS)[number])) {
        throw new ValidationError(`evidence[${j}].kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
      }
      return { ...ev, kind } as ExtractedAtomCandidate['evidence'][number];
    }) : [];
    const trigger = (a.trigger && typeof a.trigger === 'object') ? a.trigger as ExtractedAtomCandidate['trigger'] : {};
    return {
      claim,
      type: type as ExtractedAtomCandidate['type'],
      evidence,
      trigger,
      verification: a.verification as ExtractedAtomCandidate['verification'],
      pitfalls: Array.isArray(a.pitfalls) ? a.pitfalls.map(String) : undefined,
    } satisfies ExtractedAtomCandidate;
  });
  return { sessionId, project, atoms };
}
```

Add the type import to `src/validation.ts`:

```ts
import type { ExtractedAtomCandidate } from './model/provider.js';
```

- [ ] **Step 4: Add the service method**

In `src/agent-session/service.ts`, add a method that builds the extractor exactly as `extractSessionAtoms` does (`service.ts:240-244`) and ingests:

```ts
  async submitSessionAtoms(input: {
    sessionId: string;
    project?: string;
    atoms: ExtractedAtomCandidate[];
  }): Promise<ExtractFromSessionResult> {
    const session = await this.store.getAgentSession(input.sessionId);
    if (!session) {
      throw new NotFoundError(`Agent session not found: ${input.sessionId}`);
    }
    if (!this.models) {
      throw new ValidationError('No model provider configured; cannot embed submitted atoms.');
    }
    const project = input.project ?? session.project ?? 'unknown';
    const critic = new AtomCritic(this.store, this.models, {
      cache: this.cache,
      llmCriticEnabled: this.config.model?.llmCriticEnabled,
    });
    const extractor = new AtomExtractor(this.store, this.models, critic);
    return extractor.ingestCandidates(input.atoms, { project, sessionId: input.sessionId });
  }
```

Ensure imports at the top of `service.ts` include `ExtractedAtomCandidate`, `ExtractFromSessionResult`, `AtomExtractor`, `AtomCritic`, `ValidationError` (most are already imported for `extractSessionAtoms`).

- [ ] **Step 5: Add the MCP dispatch case + tools/list entry**

In `src/mcp/server.ts`, near the `tuberosa_reflect` case (line 163), add:

```ts
    case 'tuberosa_submit_session_atoms': {
      const result = await services.agentSessions.submitSessionAtoms(
        validateSubmitSessionAtomsInput(args),
      );
      services.operations.requestPhysicalMirror('agent-session-atoms-submitted');
      return toolJson({
        ...result,
        instruction: result.stored.length > 0
          ? `Stored ${result.stored.length} atom(s). Rejected ${result.rejected.length}. Stored atoms are searchable after review per your project policy.`
          : `No atoms stored (${result.rejected.length} rejected). Inspect rejected[].reasons and resubmit sharper, generalizable claims.`,
      });
    }
```

Import `validateSubmitSessionAtomsInput` in the existing validation import block. Add a `tools/list` entry mirroring an existing tool's schema (name, description, `inputSchema` with `sessionId` required, optional `project`, required `atoms` array whose items match `ExtractedAtomCandidate`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/api-boundary.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent-session/service.ts src/validation.ts src/mcp/server.ts test/api-boundary.test.ts
git commit -m "feat(learn): add tuberosa_submit_session_atoms for agent-authored atoms"
```

---

## Task 3: `learningHandoff` nudge on `finish_session`

**Files:**
- Modify: `src/agent-session/service.ts:118-221` (finishSession return)
- Modify: result type file for `FinishAgentSessionResult`
- Test: `test/agent-session.test.ts` (or the file holding finishSession tests)

**Interfaces:**
- Produces: optional `learningHandoff?: { reason: string; instruction: string; submitTool: 'tuberosa_submit_session_atoms'; session: { sessionId: string; project?: string; summary?: string; changedFiles?: string[]; verificationCommands?: string[]; decisions: Array<{ decision: string; reason?: string }> } }` on the finish result.
- Emitted only when **both**: (a) `input.reflectionDraft` was NOT supplied, AND (b) `this.models?.extractAtoms` is undefined (no model extractor → no automatic atoms). When a model extractor exists or the agent already supplied a draft, `learningHandoff` is `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-session.test.ts (add)
test('finishSession emits learningHandoff when no extractor and no draft', async () => {
  const { sessions, startedSessionId } = await setupAgentSession({ withExtractor: false });
  const finished = await sessions.finishSession({ sessionId: startedSessionId, outcome: 'completed' });
  assert.ok(finished.learningHandoff, 'expected a handoff');
  assert.equal(finished.learningHandoff?.submitTool, 'tuberosa_submit_session_atoms');
});

test('finishSession omits learningHandoff when an extractor is present', async () => {
  const { sessions, startedSessionId } = await setupAgentSession({ withExtractor: true });
  const finished = await sessions.finishSession({ sessionId: startedSessionId, outcome: 'completed' });
  assert.equal(finished.learningHandoff, undefined);
});

test('finishSession omits learningHandoff when the agent supplies a reflectionDraft', async () => {
  const { sessions, startedSessionId } = await setupAgentSession({ withExtractor: false });
  const finished = await sessions.finishSession({
    sessionId: startedSessionId,
    outcome: 'completed',
    reflectionDraft: { title: 't', summary: 's', content: 'c', triggerType: 'manual' },
  });
  assert.equal(finished.learningHandoff, undefined);
});
```

> `setupAgentSession({ withExtractor })`: build `AgentSessionService` with a provider that either has or lacks `extractAtoms` (use `HashModelProvider` for "no extractor"; a stub with an `extractAtoms` method for "with extractor"). Mirror the construction already used in this test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/agent-session.test.ts`
Expected: FAIL — `learningHandoff` is undefined in the first test.

- [ ] **Step 3: Add the type**

In the file declaring `FinishAgentSessionResult`, add:

```ts
export interface LearningHandoff {
  reason: string;
  instruction: string;
  submitTool: 'tuberosa_submit_session_atoms';
  session: {
    sessionId: string;
    project?: string;
    summary?: string;
    changedFiles?: string[];
    verificationCommands?: string[];
    decisions: Array<{ decision: string; reason?: string }>;
  };
}
```

Add `learningHandoff?: LearningHandoff;` to `FinishAgentSessionResult`.

- [ ] **Step 4: Populate it in `finishSession`**

Just before the `return { session, ... }` block (`service.ts:212`), compute the handoff:

```ts
    const extractorAvailable = Boolean(this.models?.extractAtoms);
    const learningHandoff: LearningHandoff | undefined =
      (!reflectionDraft && !extractorAvailable)
        ? {
          reason: 'No model atom-extractor is configured. You (the agent) are the highest-quality source of lessons for this session.',
          instruction: 'Reflect on what was learned and submit generalizable atoms with tuberosa_submit_session_atoms (or a free-text lesson with tuberosa_reflect).',
          submitTool: 'tuberosa_submit_session_atoms',
          session: {
            sessionId: input.sessionId,
            project: existingSession.project,
            summary: input.summary ?? input.agentOutputSummary,
            changedFiles: input.changedFiles,
            verificationCommands: input.verificationCommands,
            decisions: decisions.map((d) => ({ decision: d.decision, reason: d.reason })),
          },
        }
        : undefined;
```

Then add `learningHandoff` to the returned object:

```ts
    return {
      session,
      reflectionDraft: reflectionDraft ?? learning.draft,
      learningCandidate: learning.draft,
      autoApprovedMemory: learning.approvedDraft,
      learningDecision: learning.decision,
      compliance,
      curationNudge,
      learningHandoff,
    };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/agent-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the agent-context eval to confirm compliance shape is intact**

Run: `pnpm run eval:agent-context`
Expected: PASS (only additive field added; `compliance` unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/agent-session/service.ts test/agent-session.test.ts
git commit -m "feat(learn): emit learningHandoff on finish when no model extractor"
```

---

## Task 4: Ollama extraction as `local`-provider fallback

**Files:**
- Modify: `src/model/registry.ts:107-128` (`buildProviderRegistry`)
- Test: `test/model-registry.test.ts`

**Interfaces:**
- Consumes: `OllamaGenerationProvider` (already imported at `registry.ts:12`), `config.model.ollamaExtractModel`, `config.model.ollamaUrl`.
- Produces: under `provider=local`, the composed registry gains `extractAtoms`/`judgeAtomUtility` when `TUBEROSA_OLLAMA_EXTRACT_MODEL` is set, WITHOUT changing the `embed` slot (stays local bge-small).

- [ ] **Step 1: Write the failing test**

```ts
// test/model-registry.test.ts (add)
test('local provider composes ollama extraction when extract model is set', () => {
  const config = makeConfig({
    model: { provider: 'local', embeddingDimensions: 384, ollamaExtractModel: 'qwen2.5:3b-instruct', ollamaUrl: 'http://localhost:11434' },
  });
  const registry = buildProviderRegistry(config);
  assert.ok(registry, 'registry should be built for local provider');
  assert.equal(typeof registry?.extractAtoms, 'function', 'extraction should be wired from ollama');
});

test('local provider has no extraction when extract model is unset', () => {
  const config = makeConfig({ model: { provider: 'local', embeddingDimensions: 384 } });
  const registry = buildProviderRegistry(config);
  assert.equal(registry?.extractAtoms, undefined);
});
```

> `makeConfig` should mirror the config-builder helper already used in this test file. Provide only the `model` fields the registry reads.

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/model-registry.test.ts`
Expected: FAIL — `extractAtoms` is undefined in the first test.

- [ ] **Step 3: Wire the fallback**

In `buildProviderRegistry` (after `registry.register(local ...)`, before `return registry;` at `registry.ts:127`):

```ts
  if (config.model.ollamaExtractModel) {
    registry.registerExtraction('ollama-generation', new OllamaGenerationProvider({
      modelId: config.model.ollamaExtractModel,
      ollamaUrl: config.model.ollamaUrl,
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/model-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/registry.ts test/model-registry.test.ts
git commit -m "feat(model): wire ollama extraction as a local-provider fallback"
```

---

## Task 5: Config base, docs, and full verification

**Files:**
- Modify: `.env`
- Modify: `docs/SETUP_AND_USAGE.md`

**Interfaces:** none (configuration + docs only).

- [ ] **Step 1: Set the provider base in `.env`**

Set `TUBEROSA_MODEL_PROVIDER=local` (real embeddings + rerank). Keep `EMBEDDING_DIMENSIONS=384`. Keep `TUBEROSA_OLLAMA_*` lines as the optional headless fallback (now consumed by Task 4 only when the extract model is set).

- [ ] **Step 2: Document the model in `docs/SETUP_AND_USAGE.md`**

Add a short section: "Self-learning is agent-delegated by default — the calling agent submits atoms via `tuberosa_submit_session_atoms` (prompted by `learningHandoff` on finish). Set `TUBEROSA_OLLAMA_EXTRACT_MODEL` only for headless runs that need automatic extraction." State that `local` gives real embeddings + rerank, and Ollama embeddings are not supported (embeddings always use bge-small under `local`).

- [ ] **Step 3: Run the full gate**

Run, in order, and confirm each passes:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:agent-context
pnpm run verify:bundled-skills
```

Expected: all green. (`verify:bundled-skills` is included because `src/mcp/server.ts` changed; the new tool must not leak `docs/`, `pnpm run`, or `eval/` strings into any bundled SKILL.md — it doesn't, but the gate must confirm.)

- [ ] **Step 4: Detect changed scope before committing**

Run: `gitnexus_detect_changes()` and confirm only the expected symbols (`finishSession`, `extractFromSession`/`ingestCandidates`, `buildProviderRegistry`, the new tool/validator) are affected.

- [ ] **Step 5: Commit**

```bash
git add .env docs/SETUP_AND_USAGE.md
git commit -m "docs(learn): document agent-delegated learning + local provider base"
```

---

## Self-Review

**Spec coverage:**
- "Agent authors lessons via handshake" → Task 2 (submit tool) + Task 3 (handoff nudge). ✅
- "Ollama demoted to optional fallback" → Task 4 (wired only when extract model set) + Task 5 (`.env`/docs). ✅
- "Keep local embeddings + rerank" → Task 4 leaves `embed`/`rerank` slots local; Task 5 sets `TUBEROSA_MODEL_PROVIDER=local`. ✅
- "Reuse critic/extractor machinery" → Task 1 (`ingestCandidates`) reused by Task 2. ✅
- "Eval gates green" → Task 3 Step 6 + Task 5 Step 3. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each code step shows real code. Harness-helper references (`setupMcpHarness`, `makeConfig`, `setupAgentSession`) are explicitly flagged to mirror existing patterns in the named test files, since their exact signatures are local to those files. ✅

**Type consistency:** `ingestCandidates(candidates, { project, sessionId })` is defined in Task 1 and consumed identically in Task 2. `ExtractedAtomCandidate` shape matches `src/model/provider.ts:22`. `learningHandoff.submitTool` literal `'tuberosa_submit_session_atoms'` matches the tool name registered in Task 2. `ExtractFromSessionResult` reused unchanged across Tasks 1–2. ✅

---

## Open risk to confirm during execution

`FinishAgentSessionResult`'s exact declaration file was not opened while writing this plan (Task 3 references "the file declaring it"). First execution step for Task 3 is to locate it (`grep -rn "FinishAgentSessionResult" src/`) and add the type there. No behavior depends on guessing its path.
