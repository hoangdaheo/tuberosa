# Features & domain logic

> What the product actually does, the rules behind it, and the language the team uses.
> Read this before changing user-facing behavior or business logic.
> Companion: [`ARCHITECTURE.md`](ARCHITECTURE.md) for structure, [`CONVENTIONS.md`](CONVENTIONS.md)
> for code style.

## 1. Feature inventory

Two pillars (FIND, LEARN) plus supporting systems.

| Feature | What it does | Entry point(s) | Notes |
|---|---|---|---|
| **FIND — context search** | Retrieve a ranked context pack for a task | `src/retrieval/service.ts` (`searchContext`) | hybrid: lexical + vector + metadata + memory + graph |
| Classification | Pull files/symbols/errors/task-type from a prompt | `src/retrieval/classifier.ts` | locked by `eval/retrieval-fixtures.json` |
| Fusion & rerank | Merge candidate lists, reorder top slice | `src/retrieval/fusion.ts`, `src/model/provider.ts` | local cross-encoder default |
| Context fit + pack | Traffic-light confidence + essential/supporting/optional | `src/retrieval/context-fit.ts`, `context-pack.ts` | `ready`/`needs_confirmation`/`insufficient` |
| Feedback loop | Boost/penalize items from `selected`/`stale`/… | `src/retrieval/` + `POST /context/feedback` | feeds future ranking |
| **LEARN — agent sessions** | Track one unit of agent work | `src/agent-session/service.ts` | start → decision → finish |
| Reflection drafts | Propose a memory; humans approve before injection | `src/reflection/service.ts`, `write-gate.ts` | the safety gate |
| Atoms + critic + tiers | Sticky-note facts that graduate draft→verified→canonical | `src/atoms/extractor.ts`, `critic.ts`, `tier.ts` | auto-extract needs ollama/openai |
| Atom graph | Typed edges (`supersedes`, `refines`, …) + impact walk | `src/relations/`, `src/atoms/inference/` | powers graph expansion |
| Error logs | Persistent error journal + insight extraction | `src/error-log/service.ts`, `insights.ts` | rotating file |
| User-style atoms | `scope:"user"` prefs that follow you across projects | `src/user-style/` | `personal_workflow` / `coding_preference` |
| Export / import packs | Move knowledge between projects, with conflict resolution | `src/export/` | idempotent |
| Curation & maintenance | Cluster un-curated atoms; preview-first cleanup | `src/curation/`, `src/maintenance/service.ts` | never auto-runs destructive ops |
| Backups & physical mirror | Snapshots + one-way `.tuberosa/current/` Markdown | `src/operations/`, mirror in store | `TUBEROSA_PHYSICAL_MIRROR_ENABLED` |
| Bootstrap / atlas / sync | First-run project knowledge + project map + freshness | `src/bootstrap/`, `src/atlas/`, `src/source-sync/` | additive-only by default |
| Security | Secret redaction + prompt-injection blocking | `src/security/knowledge-safety.ts` | applied on ingest and read |

## 2. Core user flows

### Flow A — Find context for a task (FIND)
1. Agent calls `tuberosa_search_context` (or `POST /context/search`) → validated in `src/validation.ts`.
2. `RetrievalService.searchContext` runs classify → rewrite → parallel search → fuse → rerank →
   adjust → context-fit → assemble → deep-context (`src/retrieval/service.ts`).
3. Returns a **context pack**: ranked items with `matchReasons`, a `contextFit` traffic light, and
   `essential`/`supporting`/`optional` sections.
4. Agent acts, then sends feedback (`selected`/`stale`/`irrelevant`/`missing_context`), which nudges
   future ranking.

**Edge cases:** if the reranker fails, `ready` is downgraded to `needs_confirmation`;
`noiseTolerance:"strict"` drops weak items and caps prior-lessons/adjacent-context in deep context.

### Flow B — Turn a session into a memory (LEARN)
1. `tuberosa_start_session` returns initial context + a traffic light.
2. `tuberosa_record_context_decision` logs whether each note was useful.
3. `tuberosa_finish_session` (outcome = completed/failed/blocked/cancelled) runs the **learning gate**.
4. The gate either auto-approves a memory (only when learning mode is `auto` **and** all safety,
   duplicate, evidence, and usefulness gates pass) or files a **reflection draft** (status `pending`).
5. A human reviews the draft: `approve` → searchable memory; `reject` → archived; `needs_changes` →
   author edits and resubmits. **A draft is never injected into anyone's context until approved.**

> Automatic *extraction* of new lessons only runs under a generation-capable provider
> (`ollama`/`openai`). Under the default `local` (and `hash`) providers, FIND works fully and you can
> still record lessons manually.

## 3. Domain model & business rules

**Entity → type → table** (types under `src/types/`, tables from `migrations/`):

| Entity | TS type (src/types) | Postgres table |
|---|---|---|
| Knowledge item | `StoredKnowledge` (`knowledge.ts`) | `knowledge_items` (+ `_labels`, `_references`, `_chunks`) |
| Atom | `KnowledgeAtom` (`atoms.ts`) | `knowledge_atoms` |
| Context pack | `ContextPack` (`retrieval.ts`) | `context_packs`, `context_queries` |
| Agent session | `AgentSession` (`session.ts`) | `agent_sessions`, `agent_context_decisions` |
| Reflection draft / memory | `ReflectionDraft` (`session.ts`) | `reflection_drafts` → approved into `knowledge_items` |
| Relation / edge | `KnowledgeRelation` (`knowledge.ts`) | `knowledge_relations` |
| Feedback event | `FeedbackEvent` (`feedback.ts`) | `feedback_events` |
| User-style atom | `KnowledgeAtom` with `scope:"user"` | `knowledge_atoms` (`project_id NULL`, `user_id` set) |

Non-obvious rules (exact values verified against the cited source as of 2026-06-26):
- **Learning gate** (`src/agent-session/service.ts`): auto-approve requires safety + non-duplicate
  (write-gate ≠ NOOP) + evidence (≥1 reference and ≥1 file/symbol/error trigger) + usefulness, and
  `learningMode = "auto"`. Otherwise → draft. `off` → no learning.
- **Atom tiers** (`src/atoms/tier.ts`): `draft → verified` requires **all** of — a verification
  (`command` / `testRef` / `assertion`), `reuseCount ≥ 2` (`VERIFIED_REUSE_MIN`), and reuse within the
  last **90 days** (`VERIFIED_RECENCY_DAYS`). A `verified` atom demotes to `draft` after **180 days**
  idle (`DEMOTE_INACTIVITY_DAYS`); `canonical` is human-set and never time-demoted. Retrieval scales
  score by tier (`TIER_RANK_MULTIPLIERS`: draft 0.6, verified 1.0, canonical 1.4).
- **Write-gate** (`src/reflection/write-gate.ts`): `NOOP` when cosine ≥ 0.92 **and** label-overlap ≥
  0.7; `DELETE` (supersede) when cosine ≥ 0.8 **and** the draft contradicts; `UPDATE` (merge) when
  cosine ≥ 0.8, label-overlap ≥ 0.5, **and** the draft adds novel facts (>0.2 unique-token ratio); else
  `ADD`. If an embedding is unavailable it forces `ADD` (safer than deciding on a lexical proxy). It is
  a *recommendation* — never an automatic mutation.
- **Context fit** (`src/retrieval/context-fit.ts` + `config/retrieval-policy.json`): composite score =
  `0.55·top1 + 0.20·top3Avg + 0.15·coverage + 0.10·worktreeMatch`; buckets `ready ≥ 0.72`,
  `needs_confirmation ≥ 0.45`, else `insufficient`. Missing hard signals (expected file/symbol/error
  not matched) penalize and surface in `missingSignals`. If the reranker silently falls back, `ready`
  is forced down to `needs_confirmation`.
- **Duplicate detection on ingest** (`src/ingest/duplicate-detector.ts`): textual (7-gram Jaccard) and
  semantic (cosine) scored against existing items; both over threshold (`policy.duplicateJaccardThreshold`
  / `duplicateCosineThreshold`) → `reject` with `DuplicateIngestionError` (treat as "skipped"); Jaccard
  only → `block`; cosine only → `flag`.
- **Security** (`src/security/knowledge-safety.ts`): secrets redacted before storage *and* before
  embedding; prompt-injection blocked at ingest; candidates re-sanitized on the way out.

## 4. Glossary (domain terms)

| Term | Means in this project | Not to be confused with |
|---|---|---|
| Knowledge item | A page-sized note (`code_ref`/`wiki`/`spec`/`workflow`/`rule`/`bugfix`/`memory`/`conversation`) | An atom (sentence-sized) |
| Atom | One claim-shaped fact with evidence + trigger | A knowledge item |
| Label | A typed tag (`file`/`symbol`/`error`/`technology`/…) boosting metadata match | A reference (a pointer) |
| Reference | Where a note points (file+lines, URL, commit, tool) | A label (a tag) |
| Context pack | The ranked shortlist returned for one task | The raw candidate lists before fusion |
| Context-fit | The `ready`/`needs_confirmation`/`insufficient` traffic light | A relevance score |
| Session | One auditable unit of agent work | A context pack |
| Reflection draft | A *proposed* memory awaiting human review | An approved memory |
| Memory | An approved reflection, ingested as searchable knowledge | A draft (not yet approved) |
| Atom tier | Trust level: `draft` → `verified` → `canonical` | Status (`active`/`superseded`/`archived`) |
| User-style atom | A `scope:"user"` preference that follows the human across projects | A project convention |

## 5. Important behaviors & invariants

- **A reflection draft is never injected until a human approves it** — the core safety boundary.
- **No silent fake search:** under `local`/`ollama`, the real server fails loud if models can't load
  rather than serving meaningless `hash` results (override: `TUBEROSA_ALLOW_HASH_FALLBACK=true`).
- **MCP stdout is JSON-RPC only** — diagnostics go to stderr; a stray `console.log` breaks clients.
- **Provenance is preserved** — every returned item carries `matchReasons` and scores; retrieval is
  never an opaque blob.
- **`EMBEDDING_DIMENSIONS` must equal the `vector(N)` column** or you get `vector dimension mismatch`.
- **Destructive maintenance never auto-runs** — curation/maintenance is preview-first; sync is
  additive-only unless explicitly allowed.

> Threshold values above were verified directly against source on 2026-06-26 (`tier.ts`,
> `write-gate.ts`, `config/retrieval-policy.json`, `duplicate-detector.ts`). The entity→table map and
> all `src/types/*` references were confirmed against `migrations/*.sql` and `src/types/`. Re-confirm if
> those files change.
