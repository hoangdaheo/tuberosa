# Tuberosa Phase 12 — Team-Share Import (Reverse Physical Mirror)

> **Status:** ⏳ PLANNED (2026-05-22) — implementation deferred. Layers on top of Phase 11; ship Phase 11 first.
> **Author:** Solution-architect analysis pass, 2026-05-22.

## Context

The user's stated goal for Tuberosa:
> *"Feed the correct knowledge for the Agent, make AI smarter through conversation, agents can self-learn with the knowledge, and the knowledge can be export/import to a database, tracked with Git to share with other team members — local only."*

Tuberosa already implements 4 of the 5 verbs: **feed** (retrieval), **make smarter** (memory rehydration), **self-learn** (agent-session → learning gate → reflection draft → approved memory), and **export** (`.tuberosa/current/*.md` + `.jsonl` physical mirror).

**The fifth verb is the load-bearing gap: there is no `import` path.** `.tuberosa/current/` is one-way today (DB → disk). A teammate who pulls the directory via Git cannot sync those memories back into their own Postgres without re-ingesting by hand. The stated goal *cannot be achieved* without closing this gap — and that is what Phase 12.1 (Part 5 below) does.

This file consolidates: (a) goal critique, (b) pros/cons, (c) industry-terminology adoption, (d) a convention spec for a 3–10 dev team using Git as the sync layer, (e) the prioritized Phase 12+ roadmap, and (f) the one concrete next implementation step — **12.1 Reverse Physical Mirror (Git → DB import)**.

**Scope confirmed via AskUserQuestion (2026-05-22):** local-first with Git as the sync layer; small team (3–10 devs, one repo); layers on top of Phase 11 (E1–E5 + T1–T3) without disturbing it; deliverable is analysis + one concrete next step.

---

## Part 1 — Goal critique

The goal as stated is **architecturally coherent** for a small team but rests on three unstated assumptions worth surfacing:

| Hidden assumption | Why it matters |
|---|---|
| "Knowledge" is uniformly **semantic** (timeless facts) | Tuberosa stores three kinds: **semantic** (rules, wiki), **episodic** (sessions, decisions), **procedural** (workflows, playbooks). Each has different decay, sharing, and review needs. Treating them uniformly causes the Phase 10 audit failure — stale Phase-3 reflections drowned the current Phase-9 state. |
| "Self-learn" implies auto-promotion of every signal | Industry consensus (Augment Code research, Memory-R1, Mem0) is that *LLM-written* memories degrade agent quality unless **gated**. Tuberosa's learning gate is the right shape but currently only blocks auto-approval; it doesn't prevent durable drafts from being approved by a tired human. |
| Git is sufficient sync | Git resolves **add/add** cleanly (one memory per file) but is brittle on **modify/modify** of the same memory by two humans. Without a contradiction model in the data layer, two teammates can each "fix" the same memory and produce a merge artifact, not a resolved fact. |

---

## Part 2 — Pros (what Tuberosa already gets right)

- **Local-first + MCP-first**: matches the emerging "AGENTS.md layer cake" — no vendor lock-in; works with Claude Code, Codex, Cursor, Copilot via stdio.
- **Hybrid retrieval done correctly**: metadata + lexical (PG FTS) + vector (pgvector) + memory + graph relations, fused with weighted RRF, then reranked. This is the OpenSearch/Elastic/Azure AI Search default for a reason.
- **Provenance is first-class**: every candidate carries `labels`, `references`, `matchReasons`, `confidence`. Rare in the agent-memory space.
- **Reflection-draft → review → approve** mirrors Devin Knowledge and Copilot Spaces' editor/admin model — the right governance shape for shared knowledge.
- **Per-project namespaces** (Phase 6a) prevent cross-project contamination — the #1 multi-tenant risk per Mem0 and Knowledge-MCP.
- **Secret redaction at ingest + retrieval** addresses OWASP LLM Top 10 (2025) **LLM08: Vector and Embedding Weaknesses**.
- **Workbench surface** for human review of drafts, gaps, conflicts, risky auto-memories, maintenance proposals is more mature than most OSS competitors.
- **Eval discipline**: `eval:retrieval`, `eval:agent-context`, `eval:context-mapping`, `eval:safety`, sandbox. Most "agent memory" projects have zero offline evals.

## Part 3 — Cons (real weaknesses today)

| # | Weakness | Evidence in code |
|---|---|---|
| 1 | **Physical mirror is one-way** (DB → disk only). | `src/operations/backup-service.ts` — no `applyMirror()` or `importFromMirror()`. Teammates can read `.md` files but can't sync them into their DB. |
| 2 | **No content-addressable identity** for memories. UUIDs change per-DB. | Two teammates ingesting the same memory get different `knowledgeId`s — graph relations don't survive the round trip. |
| 3 | **No write-gate beyond duplicate detection**. The learning gate decides *approve vs review*, not the **ADD / UPDATE / DELETE / NOOP / CONTRADICT** decision Mem0 and Memory-R1 publish. | `src/reflection/recommendation.ts` `evaluateGates()` returns `auto_approve | needs_review` only. |
| 4 | **No bi-temporal validity model**. `freshnessAt` is a single nullable timestamp, not `valid_from + valid_to`. Conflicting facts can't coexist. | `migrations/001_init.sql` `knowledge_items.freshness_at` is one column. |
| 5 | **`metadata.markers` not yet extracted** (Phase 11 T-D fixes this). Audit-style "what's open in this document" requires reading the body. | Confirmed in Phase 11 plan. |
| 6 | **No memory-lint CI**. Git PRs touching `.tuberosa/current/` aren't validated for shape, secrets, or prompt-injection patterns. | No `.github/workflows/` entry for the mirror dir. |
| 7 | **No author / ownership field**. `agentName` in metadata is optional; no `createdBy: <email>` on knowledge items. | `src/types.ts` `StoredKnowledge` has no author. |
| 8 | **`.jsonl` schema is unversioned**. A future migration breaks restore silently. | `BackupManifest.version` exists but no validator. |
| 9 | **No glob-scoped activation** for rule-type memories. Cursor's `.cursor/rules/*.mdc` fires only on matching paths; Tuberosa's labels are categorical but not path-glob. | No `globs` field on `KnowledgeItem`. |
| 10 | **LongMemEval / RAG-triad not measured**. Tuberosa's evals are excellent for *retrieval correctness* but don't measure *memory faithfulness* the way LongMemEval-V2 (2025) and Ragas do. | `eval/` directory contains no LongMemEval fixture. |

## Part 4 — Downsides / risks (documented in the wild)

- **Memory poisoning ("the attack that waits")**: MemoryGraft (arxiv 2512.16962), MINJA, and the Unit 42 demo against Amazon Bedrock Agents (Oct 2025) all show >95% injection-success on agents with persistent memory. Tuberosa's secret-redaction does not cover *semantic* injection (e.g., a memory that says "always disable CSRF"). **Mitigation**: write-gate + memory-lint CI + provenance tracking.
- **Stale-memory regressions**: precisely the failure mode behind Phase 11 E1+E3. The recency multiplier (E3, half-life 180d, floor 0.5) is the right shape but doesn't model *supersession* — only decay.
- **LLM-written memories degrade quality**: Augment Code's published research found **LLM-generated AGENTS.md hurt task success in 5/8 settings**; only developer-written ones helped. The same applies to auto-approved reflections — be conservative.
- **Embedding inversion / PII leakage**: OWASP LLM08 (2025). Iterative re-embedding can recover ~32-token inputs; Eguard (arxiv 2411.05034) reports 95% protection. **Mitigation**: treat the vector store as PII-equivalent; do not commit raw embeddings to Git.
- **Cross-project contamination**: per-project namespace is enforced, but `agent` and `kind` filters are post-hoc, not WHERE clauses — a malformed namespace input could allow leakage. **Mitigation**: Phase 11 E4 brand types reduce this class of bug.
- **Merge-conflict pain at scale**: a small team rarely hits this; an org-wide deployment would. The bi-temporal model is the long-term answer.

---

## Part 5 — Industry-recognized terminology to adopt

Replace project-internal language with terms a new teammate will already know.

| Tuberosa today | Adopt (industry term) | Source / why |
|---|---|---|
| "reflection memory" | **semantic memory** / **procedural memory** (split the two) | Letta/MemGPT, Mem0 — distinguishes facts from playbooks. |
| "knowledge item" | **memory card** for human-edited; **doc atom** for chunked source | Cline memory bank; LangChain `Document` atom. |
| "context pack" | **context bundle** (already used) / **working memory** when active | Letta core-memory framing. |
| "label" | **facet** or keep "label" — both common | Hybrid retrieval literature. |
| "reference" | **provenance** | Anthropic, Devin Knowledge. |
| "freshnessAt" | **`valid_from` / `valid_to`** (bi-temporal) + **`ingested_at`** | Graphiti (Zep) bi-temporal model — arxiv 2501.13956. |
| "carryover" | **open item** in a document; **handoff** between sessions | Industry consensus. |
| "fusion" | **RRF (Reciprocal Rank Fusion)** | OpenSearch, Elastic, Azure AI Search default. |
| "deep context" | **parent-document retrieval** | LangChain. |
| "graph relation expansion" | **Graph-RAG** | Microsoft, Neo4j Graphiti. |
| "learning gate" decision | **write-gate**: `ADD / UPDATE / DELETE / NOOP / CONTRADICT` | Mem0, Memory-R1 (arxiv 2508.19828). |
| "namespace" | already correct — keep | Universal. |

---

## Part 6 — Convention spec for the small team

Three lightweight conventions that make Git the sharing layer actually work for 3–10 devs in one repo. Each is **additive**, **opt-in via env flag**, and **does not break Phase 11**.

### 6.1 `.tuberosa/current/` layout — one memory per file

Today the mirror writes consolidated `knowledge.md`, `reflection-drafts.md`, etc. Every change touches a big file → modify/modify merge conflicts.

**Proposed layout** (one memory per file, like Cursor `.cursor/rules/*.mdc` and Claude Code skills):

```
.tuberosa/current/
├── README.md                      # auto-generated index (top 50 by trust × recency)
├── manifest.json                  # schema version, last sync ts, row counts
├── memories/
│   ├── <stable-slug>-<short-id>.md   # one human-editable memory per file
│   └── ...
├── wiki/
│   └── <slug>.md                  # ingested wiki atoms
├── reflections-pending/
│   └── <draft-id>.md              # awaiting review
├── sessions/
│   └── <yyyy-mm-dd>-<session-id>.jsonl   # append-only episodic log
└── relations.jsonl                # one relation per line
```

**Why this shape**: matches Cline memory-bank + Cursor rules + Claude Code skills conventions; minimizes merge conflicts to add/add cases.

### 6.2 Memory frontmatter spec

YAML frontmatter on every `memories/*.md`, validated by memory-lint CI:

```yaml
---
id: <uuid>                         # stable across teammates (content-addressable fallback if absent)
title: Keep paywall product ids stable
itemType: memory | spec | workflow | rule | bugfix | wiki | code_ref
project: tuberosa
status: approved | needs_review | archived
trustLevel: 0-100
labels:
  - { type: business_area, value: paywall, weight: 1 }
  - { type: symbol,        value: PaywallSelectionModal, weight: 1 }
references:
  - { type: file, uri: src/components/paywall-selection-modal.tsx, lines: [12, 48] }
globs:                              # NEW — activation scope, Cursor-rules-style
  - "src/components/paywall-*.tsx"
validFrom: 2026-05-22T00:00:00Z     # bi-temporal: when the fact became true
validTo:   null                     # null = currently valid; set to invalidate
ingestedAt: 2026-05-22T13:01:00Z    # when Tuberosa learned it
createdBy: nanguyen@inquirer.com
supersedes: []                      # list of memory ids this replaces
schemaVersion: 1
---

# body in markdown
```

**Adopted from**: Claude Code skills frontmatter (`name`, `description`); Cursor rules (`globs`); Graphiti bi-temporal (`validFrom`/`validTo`/`ingestedAt`); GitHub frontmatter convention.

### 6.3 `TUBEROSA.md` at repo root

Mirrors the `AGENTS.md` / `CLAUDE.md` convention — a <500-word file that tells a new teammate (or agent):
- What this Tuberosa project covers
- How to start a session (the CLAUDE.md startup rule already does this — promote it to TUBEROSA.md so it's tool-agnostic)
- How to write a memory (link to the frontmatter spec above)
- The PR-review checklist for memory changes

This is the team's **onboarding contract** for Tuberosa. It is *not* a memory itself.

---

## Part 7 — Phase 12+ roadmap (layered on Phase 11)

Prioritized by team-leverage / cost ratio. Each is independently revertible.

| # | Piece | Lever | Cost | Notes |
|---|---|---|---|---|
| **12.1** | **Reverse physical mirror** (Git → DB import path) | **Highest** — closes the stated goal | Medium | Detailed in Part 8 as the concrete next step. |
| 12.2 | One-memory-per-file mirror layout + frontmatter spec | High | Medium | Part 6.1+6.2 above; required for 12.1 to merge cleanly. |
| 12.3 | Content-addressable memory IDs (`sha256(canonical_yaml)`) as a fallback when UUID absent | High | Low | Lets two teammates ingest the same memory and converge. |
| 12.4 | Bi-temporal validity (`validFrom` / `validTo`) replaces single `freshnessAt` | High | Medium | Migration + retrieval policy change; matches Graphiti. |
| 12.5 | Write-gate `ADD / UPDATE / NOOP / CONTRADICT` on reflection drafts | High | Medium | Extend `evaluateGates()`; surface decision in workbench. |
| 12.6 | Memory-lint CI (`.github/workflows/tuberosa-memory-lint.yml`) | High | Low | Validates frontmatter, runs safety scan, flags duplicates/contradictions; blocks merge on errors. |
| 12.7 | `globs:` activation scope on rule-type memories | Medium | Low | Cursor-rules pattern; one additional `searchMetadata` filter. |
| 12.8 | LongMemEval-V2 + Ragas RAG-triad evals added to `eval/` | Medium | Medium | Closes the credibility gap when sharing Tuberosa publicly. |
| 12.9 | `tuberosa import-mirror` CLI subcommand | Medium | Low | Wraps 12.1's library call; teammate-friendly. |
| 12.10 | `createdBy` + `lastEditedBy` audit fields on knowledge items | Low | Low | Required for any future RBAC. |

Items 12.1 → 12.3 → 12.4 form a tight dependency chain — they should ship in that order or together. The rest are independently sequenced.

---

## Part 8 — Concrete next step: **Phase 12.1 — Reverse Physical Mirror (Git → DB import)**

The single piece that unlocks the stated goal. Sized to ship in one focused session after Phase 11 lands.

### 8.1 Why this one first

Without import, the export is decorative. A teammate who pulls a memory from Git has to manually POST it to their HTTP API to actually use it — which nobody does. This is the load-bearing gap behind the user's goal sentence.

### 8.2 Behavior

```bash
# Teammate pulls Git; .tuberosa/current/ now has new/edited memories
pnpm run mirror:import                  # dry-run by default
pnpm run mirror:import -- --apply       # writes to local DB
pnpm run mirror:import -- --apply --project tuberosa --since HEAD~5
```

The importer:
1. Reads `.tuberosa/current/manifest.json` → validates `schemaVersion`.
2. Walks `memories/*.md`, parses YAML frontmatter, validates against the spec (8.4 below).
3. For each memory, computes a content-addressable hash if `id` absent: `sha256(canonicalize(frontmatter) + '\n' + body)`.
4. Compares against the local DB:
   - **Not present** → `ADD` (insert as `status: needs_review` unless `--auto-approve-from-trusted`).
   - **Present, same hash** → `NOOP`.
   - **Present, different hash, newer `validFrom`** → `UPDATE` (insert new row, set previous row's `validTo = new.validFrom`, write `supersedes` relation).
   - **Present, different hash, same `validFrom`** → `CONTRADICT` (insert as `needs_review`, do not invalidate previous).
5. Re-embeds the chunk content (embeddings are **not** committed to Git).
6. Emits a per-row import report (`import-report-<ts>.md`) into `.tuberosa/current/imports/` so the next teammate can see what changed.

### 8.3 Files to create / modify

**New:**
- `src/operations/mirror-import.ts` — `MirrorImportService` with `dryRun(input)` + `apply(input)`. Returns `{ adds, updates, noops, contradictions, errors }`.
- `src/operations/mirror-frontmatter.ts` — YAML schema + Zod-style validator; one source of truth shared with the lint CI.
- `scripts/mirror-import.ts` — CLI entry; wires `MirrorImportService` to the active `KnowledgeStore`.
- `test/mirror-import.test.ts` — 8 cases (see 8.5).
- `eval/mirror-roundtrip-fixtures.json` — golden round-trip cases (export → re-import → DB equivalent).
- `migrations/00X_content_hash.sql` — adds nullable `content_hash` column + index on `knowledge_items`.

**Modified:**
- `src/operations/backup-service.ts` — when writing `memories/*.md`, emit the frontmatter spec in 6.2; write `manifest.json` with `schemaVersion: 1`.
- `src/types.ts` — add `MirrorImportInput`, `MirrorImportReport`, `MirrorDecision = 'ADD' | 'UPDATE' | 'NOOP' | 'CONTRADICT' | 'ERROR'`.
- `src/storage/store.ts` — add `findByContentHash(hash): Promise<StoredKnowledge | undefined>`.
- `src/storage/postgres-store.ts` + `src/storage/memory-store.ts` — implement above.
- `src/app.ts` — wire `mirrorImport` into `AppServices`.
- `src/mcp/server.ts` — add a read-only `tuberosa_preview_mirror_import` MCP tool (dry-run only) so agents can preview before a human runs `--apply`.
- `package.json` — `"mirror:import": "tsx scripts/mirror-import.ts"`.

### 8.4 Frontmatter validator (one source of truth)

The same validator gates **import** (this phase) and **lint CI** (Phase 12.6). Required keys: `id | content_hash`, `title`, `itemType`, `project`, `validFrom`, `schemaVersion`. Optional: everything else in 6.2. Rejects unknown keys (forwards-incompatible by design — bump `schemaVersion`).

### 8.5 Regression fixtures (write first)

1. **round-trip identity** — export → re-import → DB row equivalent (modulo timestamps). All decisions `NOOP`.
2. **add new memory** — file present in mirror, absent in DB → one `ADD`; row created as `needs_review`.
3. **update with supersession** — existing memory, new `validFrom`, different hash → one `UPDATE`; previous row's `validTo` patched; `supersedes` relation written.
4. **contradiction** — same `validFrom`, different hash → one `CONTRADICT`; both rows present; `needs_review` flag.
5. **malformed frontmatter** — missing `itemType` → one `ERROR`; rest of batch still applied.
6. **secret in body** — body contains `sk-XXX` → rejected by `knowledge-safety` (existing path); reported as `ERROR`, not `ADD`.
7. **schemaVersion mismatch** — manifest says `2`, importer is `1` → abort batch, exit code 2, no partial writes.
8. **dry-run preserves DB** — `--apply` omitted; assert DB row count unchanged after run.

### 8.6 Verification

```bash
pnpm install
pnpm run build
pnpm test                                # full unit suite, incl. mirror-import.test.ts
pnpm run eval:retrieval                  # must stay 15/15 (Phase 11 baseline)
pnpm run eval:agent-context              # must stay green
pnpm run eval:safety                     # must stay 100/100/100
pnpm run mirror:import -- --project tuberosa    # dry-run on real .tuberosa/current/
pnpm run mirror:import -- --apply --project tuberosa
# End-to-end team round trip:
#   1. dev-A creates a memory via MCP; mirror exports it
#   2. dev-A commits .tuberosa/current/memories/<file>.md, pushes
#   3. dev-B pulls, runs `pnpm run mirror:import -- --apply`
#   4. dev-B's MCP search now surfaces the memory; provenance shows createdBy: dev-A
```

### 8.7 Risk table

| Risk | Catching fixture |
|---|---|
| Importer overwrites a teammate's local-only memory | content-hash + bi-temporal `validFrom` resolves to `CONTRADICT`, not silent `UPDATE`; test case 4 |
| Re-embedding cost spikes on large pulls | importer batches `embed()` calls and reports tokens used; CI threshold guards |
| Secret leaks through frontmatter (e.g. `description: "use sk-XXX"`) | safety scan runs on full file before insert; test case 6 |
| Schema drift between exporter and importer | `manifest.json.schemaVersion` validated; test case 7 |
| Round-trip loses data | golden fixture asserts byte-equivalent re-export after import; test case 1 |
| Two teammates push conflicting edits to the same memory file | Git resolves to one body; importer treats the merged file as `UPDATE` if `validFrom` advanced, else `CONTRADICT`. Document this in `TUBEROSA.md`. |

### 8.8 Rollback

`mirror:import` is opt-in (no daemon). To roll back: delete the script and `mirror-import.ts`; the export path is unaffected. The new `content_hash` column is nullable and ignored by existing code.

---

## Part 9 — Open questions for the implementer

1. **Auto-approval policy on import.** Default proposed: imported memories land as `needs_review` regardless of source DB's `status`. Alternative: trust the source DB if the importer is configured with `--trust-source`. Which fits the small-team norm?
2. **Embedding strategy on import.** Re-embed every time (slow, deterministic) vs cache by `content_hash` (fast, but cache invalidation on model change is subtle). Recommended: re-embed; add cache as Phase 12.1.1 if profiling demands.
3. **Should `sessions/*.jsonl` be in Git at all?** They're episodic, append-only, and grow forever. Recommended: keep `sessions/` git-ignored by default; opt-in for teams that want shared session history.
4. **Reflection drafts shared via Git?** Reviewable items are inherently in-flight. Recommended: keep `reflections-pending/` in Git so reviewers see each other's queue, but don't import drafts via `mirror-import` — only approved memories cross the Git boundary.

---

## References

Industry sources from the research pass:

- Graphiti / Zep bi-temporal KG — arxiv 2501.13956
- Mem0 evaluation + write-gate — vectorize.io/articles/mem0-vs-letta
- Memory-R1 ADD/UPDATE/DELETE/NOOP — arxiv 2508.19828
- AGENTS.md spec — agents.md
- LongMemEval-V2 — arxiv 2605.12493
- MemoryGraft (memory poisoning) — arxiv 2512.16962
- OWASP LLM Top 10 (2025) — LLM08 Vector and Embedding Weaknesses
- Eguard (embedding inversion defense) — arxiv 2411.05034
- Cline memory bank docs; Cursor `.cursor/rules` docs; Claude Code skills docs; Anthropic memory tool docs
