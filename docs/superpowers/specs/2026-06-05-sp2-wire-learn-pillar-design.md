# SP2 — Wire the LEARN Pillar — Design Spec

Date: 2026-06-05. Status: approved by owner (this session).
Engagement: Tuberosa de-bloat (`docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md` §5).
Branch: `sp2-wire-learn-pillar` off local `main` (post-SP3, `24ff408`). Owner handles pushes.

---

## 1. Problem

The LEARN pillar (session → atoms → curation → conventions → retrieval) is dead in real use.

Verified root cause (current line numbers, post-SP3):

| Fact | Evidence |
|---|---|
| `extractAtoms?` is optional on `ModelProvider` | `src/model/provider.ts:27` |
| Only `HashModelProvider` implements it (test fixtures) | `src/model/provider.ts:86` |
| `OpenAiModelProvider` has `judgeAtomUtility` but NOT `extractAtoms` | `src/model/provider.ts:245` |
| Extractor early-returns with 0 atoms when the method is missing | `src/atoms/extractor.ts:41` |
| Owner's provider is `ollama` | `.env`: `TUBEROSA_MODEL_PROVIDER=ollama` |

**New finding (the handoff did not know this):** the "ollama" provider is a
`ProviderRegistry` composition (`src/model/registry.ts:103`) of `hash`
(embed/rewriteQuery) + `OllamaRerankProvider` (rerank only — a cross-encoder
model that cannot generate text). The registry proxies ONLY
`embed`/`rewriteQuery`/`rerank`; it strips `extractAtoms`, `judgeAtomUtility`,
and `extractPromptIntent` from any provider it wraps. So implementing
`extractAtoms` on a provider is not enough — the registry must pass it through,
and Ollama needs a NEW generation call (the reranker can't do it).

Everything downstream of the extractor is built and tested (~30 test files:
`atoms-*`, `curation-*`, `convention-*`). The gap is only at the provider layer.

## 2. Owner decisions (recorded this session)

1. **Ollama generation model: new env var, off by default.**
   `TUBEROSA_OLLAMA_EXTRACT_MODEL` (e.g. `qwen3.5:latest`). Unset → extraction
   off + one-time stderr note. No surprise LLM calls.
2. **Ollama also implements `judgeAtomUtility`** with the same model, so the
   critic's stage-4 LLM gate works on the owner's real setup.
3. **Dual-persistence unification: DEFERRED** (park in handoff §7).
4. **Live testing: Ollama only** (local `qwen3.5:latest`, verified pulled).
   OpenAI path covered by mocked-fetch unit tests; no API key spent.
5. **Architecture: shared prompt+parser, thin transports.**

## 3. Design

### 3.1 New shared module — `src/model/atom-extraction.ts`

- `ATOM_EXTRACTION_SYSTEM_PROMPT` — single extraction prompt used by both
  providers. Asks for generalizable engineering lessons from a finished
  session: claim, type ∈ `fact|procedure|decision|gotcha|convention`,
  evidence (≥1), trigger, optional verification, optional pitfalls. Tells the
  model to return few high-value atoms (not a transcript summary) and to keep
  claims ≤ 240 chars (the critic's floor at `src/atoms/critic.ts:68`).
- `atomExtractionSchema()` — JSON schema for
  `{ atoms: ExtractedAtomCandidate[] }` (object root: both OpenAI strict mode
  and Ollama structured outputs require an object, not a bare array).
- `parseExtractedAtoms(text: string): ExtractedAtomCandidate[]` — one
  parser/normalizer: validates each entry independently, drops invalid entries
  (does not fail the batch), clamps claim length, caps at 8 candidates.

### 3.2 OpenAI — `extractAtoms` on `OpenAiModelProvider`

- Thin method next to `judgeAtomUtility` (`src/model/provider.ts:245`), using
  the existing `fetchOpenAiJson` → `/v1/responses` structured-output pattern
  (`provider.ts:421`).
- Model: reuses `config.model.openAiRerankModel` — the same slot
  `judgeAtomUtility` uses. No model configured → return `[]` (fail-open,
  consistent with existing style).

### 3.3 Ollama — new `OllamaGenerationProvider`

- New class (own file `src/model/ollama-generation.ts`); NOT an edit to
  `OllamaRerankProvider`.
- Calls `POST {ollamaUrl}/api/chat` with
  `{ model, messages: [system, user], format: <json schema>, stream: false }`
  (Ollama structured outputs). Parses `message.content` with the shared parser.
- Implements `extractAtoms` AND `judgeAtomUtility`.
- Failure mode: network/HTTP/parse failure → `ModelProviderError` (no silent
  hash fallback — extraction has no meaningful fallback; the caller already
  converts failures into observable knowledge gaps).
- Injectable `fetchFn` for tests (same seam as `OllamaRerankProvider`).

### 3.4 Config — `src/config.ts`

- `config.model.ollamaExtractModel?: string` ←
  `TUBEROSA_OLLAMA_EXTRACT_MODEL` (optional, no default).
- Document in `docs/MINIMAL_ENV.md`: atom extraction under ollama requires
  this var; under openai it requires `OPENAI_RERANK_MODEL`.

### 3.5 Registry passthrough — `src/model/registry.ts`

- `ProviderRegistry` gains optional extraction wiring: `extractAtoms` /
  `judgeAtomUtility` are assigned **as instance properties only when a
  backing provider supplies them**. A registry without an extraction provider
  has NO `extractAtoms` property, so the extractor's capability check
  (`extractor.ts:41`) stays honest.
- `buildOllamaRegistry` constructs `OllamaGenerationProvider` and wires it in
  only when `config.model.ollamaExtractModel` is set.
- When `provider === 'ollama'` and the var is unset: one-time **stderr** note
  ("atom extraction disabled; set TUBEROSA_OLLAMA_EXTRACT_MODEL to enable").
  Never stdout (MCP protocol constraint).

### 3.6 Critic tuning (work item 4) — measure first

No pre-emptive threshold or rule changes. After the live loop runs, read
reject reasons via `tuberosa_atom_gate_stats` / `atom_gate_events`. Only if
real atoms are wrongly rejected do we adjust a rule — and any heuristic change
gets a failing test/fixture FIRST (handoff §2 constraint).

## 4. Error handling

- Provider/network failure → `ModelProviderError` → caught at
  `src/agent-session/service.ts:261` → recorded as a knowledge gap
  (`missingSignals: ['atom_extraction']`). Session finish never breaks.
- Malformed model output → invalid candidates dropped individually; `[]` is a
  valid result.
- Per-candidate storage failures already handled by extractor/critic.

## 5. Verification

| Layer | How |
|---|---|
| Unit (TDD) | Parser tests (valid/invalid/oversized/empty); OpenAI `extractAtoms` mocked fetch; `OllamaGenerationProvider` mocked fetch (extract + judge); registry passthrough present-when-configured + absent-when-not |
| Deterministic e2e | Hash `fixtureAtoms` drives finish_session → atoms → curation nudge (existing `atoms-finish-session.test.ts` pattern); new `eval:knowledge-completeness` fixture proving extraction wiring |
| Live e2e (owner's setup) | Real loop vs local `qwen3.5:latest`: finish_session → atoms created → nudge at 5 (`agent-session/service.ts:54`) → `tuberosa_propose_curation` → approve → convention in retrieval lane + atlas `conventions.md` |
| Gates | `pnpm test` (baseline 773), `eval:knowledge-completeness`, `eval:agent-context`, `eval:retrieval` (hitRate=1, staleRejectionRate=1, exact rates=1), `test:integration` if Docker up |

Known pre-existing failures NOT in scope: `eval:context-mapping`
(`paywall-modal-implementation`, `auth-flow-doc-lookup`) — predate SP1/SP3.

## 6. Out of scope

- ❌ Dual-persistence unification (`reflection/service.ts:100-159`) — deferred.
- ❌ `extractPromptIntent` for Ollama (registry strips it too, but that is the
  long-prompt path, not LEARN) — deferred, noted for handoff §7.
- ❌ Pre-existing `eval:context-mapping` failures.
- ❌ Any change to fusion weights, classifier, context-fit, pack assembly.

## 7. Global constraints honored

Store parity (no store changes expected); MCP stdout protocol-only; one pnpm
command at a time (Node 22.21.1 PATH prefix if needed); subagents commit
specific files only (never `git add -A`); no `Co-Authored-By: Claude` trailer;
eval-first for any heuristic change; owner pushes.
