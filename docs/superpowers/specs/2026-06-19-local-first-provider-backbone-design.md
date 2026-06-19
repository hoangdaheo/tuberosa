# Local-First Provider Backbone — No Silent Fake Search

_Design spec. Date: 2026-06-19. Status: approved (brainstorming), pending implementation plan._

## 1. Problem

Tuberosa's real-world retrieval can silently fall back to the **hash** model provider — a
deterministic math trick with no semantic meaning. When that happens, vector search compares
meaningless numbers and **no one is told**. The product looks like it is working while quietly
returning fake-quality results.

This is unacceptable for the project goal: **Tuberosa must be effective in real-world use for
every user, on any machine, without an API key, offline-capable after setup.**

A second motivation: the local cross-encoder rerank blend (`0.70·model + 0.22·fused + 0.08·trust`)
has **zero test coverage**. The retrieval eval pins `provider=hash`, so the real reranker and its
blend weights are never exercised by any gate.

## 2. Goals / Non-Goals

### Goals
- Real-world runs (HTTP server + MCP stdio server) **never silently use hash** for embeddings or rerank.
- If real local models are unavailable, **fail loud** with a clear remedy, instead of degrading to fake search.
- Local embeddings + local cross-encoder are **easy to install and verify** via a setup command and `doctor`.
- Works for **every user**: no API key required, offline-capable after setup, cross-platform.
- The rerank blend gets **real test coverage**.

### Non-Goals (YAGNI)
- **MCP sampling** — Claude Code does not support `sampling/createMessage` (open issue, unshipped) and the
  sampling spec itself was deprecated 2026-07-28. We will not build on it.
- **Per-user personalization** — separate engagement; the existing user-style layer is untouched.
- **Deleting hash from the codebase** — hash remains the deterministic provider for tests/CI/eval and the
  embedded trial. Removing it would break determinism across ~40 test files.
- **Query-rewrite overhaul** — rewrite gives "near-zero gain post-reranker" (`service.ts:158`); left as-is.

## 3. Architectural constraint that shaped this design

MCP is request/response. An MCP **server cannot call back into the client agent's LLM** mid-request
(no `sampling` support in Claude Code; spec deprecated). Therefore "let the calling agent do the AI task"
is only viable where it already is: the **LEARN** path (agent authors lessons via
`tuberosa_submit_session_atoms` after the session). Search-time AI (embed/rewrite/rerank) **must** run
server-side. Embeddings in particular can never be delegated — vector search needs them at ingest and
query time, computed by the server. Hence: a robust **local** embedder + reranker is mandatory.

## 4. Review findings (current leaks)

| # | Leak | Location | Severity |
|---|------|----------|----------|
| 1 | Silent fake embeddings: `embed()` delegates to hash when the local model fails to load | `src/model/local-provider.ts` (embed fallback) | High |
| 2 | Silent final fallback: factory returns `new HashModelProvider(...)` for any unhandled case | `src/model/factory.ts:20` | High |
| 3 | Untested rerank blend `0.70/0.22/0.08` | `src/model/local-provider.ts:179` | Medium |
| 4 | `doctor` embedding-model remediation says "or fall back to hash" (wrong mental model) | `bin/commands/doctor.ts:197` | Low |
| 5 | `ollama` provider has fake (hash) embeddings by design | `src/model/ollama-provider.ts` | Low (documented) |

Strengths to preserve: query-time rerank try/catch degrades to **real** fused order (`service.ts:840`);
the injectable `LocalCrossEncoderScorer` hook (`local-provider.ts:41`) makes the blend testable; the
already-shipped agent-delegated LEARN path.

## 5. Design

### 5.1 Strict mode (safety boundary)
When `provider=local` (real-world default), the runtime is **strict**:
- **Embeddings must be real or the server refuses to start.** Startup loads the embedding model; on
  failure it exits with a clear message pointing to `npx tuberosa setup-models`. No silent hash embeddings.
- **Cross-encoder is verified at startup** (same remedy on failure). Query-time rerank keeps its existing
  try/catch but degrades to **real fused order**, never hash.
- **hash is reachable only via explicit `TUBEROSA_MODEL_PROVIDER=hash`** (tests/CI/trial). The silent
  `factory.ts:20` fallback is removed; in strict mode a registry that cannot be built **throws**.
- **Escape hatch:** `TUBEROSA_ALLOW_HASH_FALLBACK=true` (default `false`) lets a power user knowingly run
  degraded. Off by default; documented as "fake search — for debugging only."

### 5.2 Robust local provider
- Embeddings get their **own hard guarantee**, independent of rerank. In strict mode the embed path throws
  a typed `ModelUnavailableError` rather than delegating to hash; the startup health check surfaces it.
- The cross-encoder blend is unchanged in behavior but **becomes tested** (5.4).

### 5.3 Setup & availability
- **`npx tuberosa setup-models`** (new CLI command): pre-downloads bge-small (embeddings) + bge-reranker
  (cross-encoder) ONNX into the model cache, shows progress, and **verifies they load**. Idempotent;
  offline-capable afterward.
- **`tuberosa doctor`** extended: add a **reranker-model check**; rewrite the embedding-model remediation
  from "fall back to hash" to "run `npx tuberosa setup-models`"; optional `--deep` flag that actually loads
  the model (not just checks the directory exists).
- **`tuberosa init`** runs `setup-models` during onboarding. **`docs/SETUP.md`** gains a setup guide.

### 5.4 Tests & eval
- hash **stays** the test/eval provider; `eval:retrieval` stays byte-for-byte green.
- **New unit test** for the rerank blend via the injectable scorer: assert `0.70/0.22/0.08` ordering and
  that a degenerate weight reorders (closes the coverage gap).
- **New strict-mode tests**: broken local registry → throws (not hash); invariant test that the real path
  never instantiates hash unless `provider===hash`.

## 6. Data flow (after)

```
REAL RUN (provider=local, strict):
  startup -> load embed model -> load reranker -> both OK? -> serve
                  | fail              | fail
                  +---------+---------+
                            v
        ERROR: "run npx tuberosa setup-models"   (never silent-fake)

  search -> rewrite(local/none) -> embed(REAL or error) -> fuse -> rerank(REAL; degrade=real fused order)

TESTS / CI:  TUBEROSA_MODEL_PROVIDER=hash  -> deterministic, as today
```

## 7. Anticipated change surface (for the plan; not exhaustive)
- `src/model/factory.ts` — remove silent hash fallback; throw in strict mode.
- `src/model/local-provider.ts` — strict embed guarantee (typed error, no silent hash); keep blend.
- `src/model/registry.ts` — strict-mode behavior when a capability can't be fulfilled.
- `src/config.ts` — resolve strict flag + `TUBEROSA_ALLOW_HASH_FALLBACK`.
- `src/index.ts`, `src/mcp-stdio.ts` (or their server bootstrap) — startup model health check.
- `bin/commands/setup-models.ts` (new) + `bin/tuberosa.ts` + `bin/commands/parser.ts` — wire the command.
- `bin/commands/doctor.ts` — reranker check + remediation wording + `--deep`.
- `bin/commands/init.ts` — call setup-models.
- `docs/SETUP.md` — setup guide.
- Tests: blend unit test, strict-mode tests, invariant test.

## 8. Risks & mitigations
- **Startup model load adds latency / could block boot.** Mitigate: `setup-models` pre-warms; cache hit on
  subsequent boots is fast; a clear error is better than silent fake search.
- **Air-gapped machines.** `setup-models` run once on a connected machine populates the cache, which can be
  copied; documented in SETUP.md.
- **CI / embedded trial must stay deterministic.** Both already set `provider=hash`/`TUBEROSA_EMBEDDED`,
  which remains fully supported — strict mode only applies to `provider=local`.
- **Eval determinism.** Unchanged: eval keeps `provider=hash`.

## 9. Verification
- `pnpm run build`
- `pnpm test` (incl. new blend + strict-mode + invariant tests)
- `pnpm run eval:retrieval` (must stay green)
- `pnpm run eval:agent-context`
- `pnpm run verify:bundled-skills`
- Manual: `npx tuberosa setup-models` then `npx tuberosa doctor` on a clean cache; confirm fail-loud when
  the cache is removed and `TUBEROSA_ALLOW_HASH_FALLBACK` is unset.
