# Rule: Workflow & conventions

## Git

- **Commit only when the user asks.** Do not commit or push as a side effect of finishing work.
- **The owner pushes the default branch.** Agents may create commits, but do **not** push to `main` (the auto-mode classifier blocks agent pushes to `main`; commits are fine). Branch for non-trivial work.
- **No AI co-author trailer.** Do not add `Co-Authored-By: Claude …` or "Generated with …" trailers to commits — the owner uses many agentic tools and does not want one credited.

## Runtime

- Node is pinned to `22.21.1` (`.nvmrc`). If the shell uses an older Node, prefix commands: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm …`.
- **Do not run multiple `pnpm` commands concurrently** — pnpm workspace state has produced transient JSON parse failures during concurrent runs.

## Verification before finishing

Run the gates and report what you ran (see also `@.claude/rules/key-constraints.md`):

- Narrow code change → `pnpm run build` && `pnpm test`.
- Shared TypeScript type change → always `pnpm run build` (tsc), not just the tsx test runner — tsx strips types and won't catch broken config literals.
- Retrieval change (classifier / fusion / rerank / context-pack / context-fit) → also `pnpm run eval:retrieval` (must stay `hitRate=1`, `staleRejectionRate=1`, all classification rates `=1`; fix logic, never relax thresholds).
- Storage / migration / cache / Docker change → also `pnpm run test:integration`.
- Reranker change → also `pnpm run eval:local-model`. **Hash-only evals (`eval:retrieval`, `sandbox`) cannot see the real cross-encoder** — they build a `HashModelProvider` — so they can never validate real rerank quality. The live smoke eval is the only check that loads the real model (self-skips when models aren't downloaded).
- Run `git diff --check` before handing off.

## Orientation — read these for full project context

- [`README.md`](../../README.md) — full mechanism (FIND/LEARN, pipeline, config, API).
- [`nash-readme.md`](../../nash-readme.md) — the same, in plain ELI5 language.
- [`AGENTS.md`](../../AGENTS.md) — source map, API surface, dev notes.
- [`docs/tuberosa-project.md`](../../docs/tuberosa-project.md) — product intent and design notes; read before substantial work.
- [`handoff.md`](../../handoff.md) — **live working state**: what's in flight, what's uncommitted, what failed and why. Check it at the start of a tuberosa session; it can be stale, so verify against the repo.
