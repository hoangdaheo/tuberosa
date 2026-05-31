# Project Knowledge-Book — Design

**Status:** Design approved in brainstorming, pending user spec review
**Date:** 2026-05-31
**Author:** Brainstorming session with user
**Scope:** Let any newcomer (agent or human) inherit a project's conventions, code-style, and the author's/members' "how we do things here" — as both a readable handbook and rules that fire mid-task.
**Depends on (all shipped):**
- [User-Style Preference Layer (Concern F)](2026-05-27-user-style-preference-layer-design.md) — the **Personal layer** + `scope`/`priority` discriminator this design extends.
- [P1 Plan 2 — Project Atlas](2026-05-29-p1-atlas-design.md) — the deterministic markdown synthesis this design adds a `conventions.md` file to.
- [Project Bootstrap + Export V2](2026-05-29-project-bootstrap-export-v2-design.md) — the `tuberosa bootstrap` first-run command this design adds a convention-extraction stage to.
- [Knowledge Atom Schema](2026-05-26-knowledge-atom-schema-design.md), [Write-Gate, Dedup, Decay](2026-05-26-write-gate-dedup-decay-design.md), [Project Export Bundle](2026-05-26-project-export-bundle-design.md).

---

## 1. Problem

A person or agent opening a project they have never seen starts cold. The author's conventions, code-style, architectural decisions, and hard-won gotchas live in that author's head, scattered docs, or implicit patterns in the code. Today Tuberosa accumulates **project knowledge** and **personal user-style**, but:

1. **No coherent "how we do things here" artifact.** The atlas (`project-map.md`, `flows.md`, `commands.md`, `risks.md`, `open-gaps.md`) describes *what the project is*, not *the conventions you must follow while working in it*. There is no captured "code-style", "testing convention", or "error-handling philosophy" for the project.
2. **No team layer.** User-style is per-person and cross-project; project knowledge is per-repo. There is nothing in between — no **shared, transferable team conventions** a newcomer inherits. (The user-style spec listed this as an explicit deferred non-goal.)
3. **Raw, not distilled.** Reflection memories are stored close to verbatim (`"Learn from session: <prompt>"`). Nothing collapses `"add useMemo at line 42"`, `"add useCallback at line 88"`, `"check memo deps for side-effects"` into one reusable rule `"In React, profile before memoizing; verify useMemo/useCallback deps and side-effects."` The learning gate filters for *duplication/grounding/maturity*, not for *value or generalizability*, and performs **no abstraction**.
4. **No "recall like a human".** Even when relevant knowledge exists, it competes in ranking like any other candidate; there is no "you're touching auth — here is the convention, do A then B then C" experience.

## 2. Goal

A **Project Knowledge-Book**: one layered, curated body of conventions that a newcomer inherits on day one, surfaced two ways —

- **Handbook view** — a readable, grouped document (`conventions.md`, rendered alongside the existing atlas) for onboarding.
- **Rules view** — the same conventions as atomic, triggerable rules pinned to the top of the context pack when the current task matches.

…produced by the **calling agent's judgment** (Tuberosa has no internal text-generation seam), governed so durable/shared writes pause for a human, and transferable to teammates via the existing export/import packs.

## 3. Non-goals (deferred)

| Out of scope here | Why / where |
|---|---|
| An internal LLM/text-generation seam in `ModelProvider` | The calling agent does all reasoning; Tuberosa stays deterministic. Matches the atlas "deterministic-only, gloss deferred" precedent. |
| A learned trigger-matching index | v1 trigger-matching is heuristic tag intersection; a dedicated index is the later upgrade (the "Approach B" path). |
| Cross-user style merging ("inherit Bob's style") | Future; this design adds the **team** layer, not per-user inheritance. |
| Auto-resolving semantic conflicts on import | Reuse existing `tuberosa_list_atom_import_conflicts` / `resolve_atom_import_conflict`. |
| A new UI/workbench surface | Workbench was removed (PR #20); delivery is via MCP tools + `.tuberosa/atlas/` files. |
| Rewriting retrieval fusion ranking | Conventions enter as a new pinned lane; fusion is untouched. |

## 4. Decisions (locked during brainstorming)

| # | Area | Decision | Rationale |
|---|---|---|---|
| 1 | Artifact | **Both** — handbook view + rules view, two projections of one convention set | Onboarding needs reading; mid-task needs firing. |
| 2 | Canonical form | **Rules (convention atoms) are canonical; handbook is the rendered/grouped view** | One source of truth; the two never drift. Handbook regenerated deterministically on demand. |
| 3 | Source | Bootstrap from **codebase + existing docs + auto-detected stack**, kept living by **session accumulation + on-demand curation** | Captures the author's way even if never written down; stays current. |
| 4 | Layers | **3 layers: Personal → Team → Project**, each atom tagged with `scope` + `author` | Reuses the existing `scope` discriminator on `knowledge_atoms`; adds `scope='team'`. |
| 5 | Precedence | **`personal_workflow` > Project > Team > Personal `coding_preference`** | "When in Rome" for style, but inviolable personal-workflow guarantees (e.g. "no Claude co-author trailer") are never silently overridden. Extends the existing user-style priority rule. |
| 6 | Reasoner | **The calling agent** distills, scores, assigns scope; Tuberosa records the verdict | `ModelProvider` has no text-generation seam; the smart model is already in the loop; keeps eval deterministic with `HashModelProvider`. |
| 7 | Governance | **Bootstrap drafts + Team/Global promotion → human review; living Project rules with ≥2 evidence + passing gates → auto-activate** | High-blast-radius writes get the gate; routine project learning flows. |
| 8 | Automation | **Automatic where safe (offer bootstrap, auto-read handbook, nudge curation); confirmation gate on every durable/shared write** | Fewest commands; human controls what is kept. |
| 9 | Transfer | Team layer rides existing `tuberosa_export_pack` / `tuberosa_import_pack` | The whole point of "global = team-shared". |
| 10 | Build | **Extend existing primitives** (atoms+`scope`, atlas, bootstrap, reflection-draft review); one small migration to add `scope='team'` | Lowest risk; matches conventions; keeps `eval:retrieval` green. |

## 5. Data model — a Convention is an atom

A **Convention** is a `knowledge_atoms` row, reusing the existing `scope`/`user_id`/`priority` columns and adding convention-specific fields in the atom's structured payload/metadata:

```
scope     : 'user' | 'team' | 'project'      -- extends existing CHECK ('project','user')
user_id   : set when scope='user'
team_id   : set when scope='team'            -- new column, mirrors user_id
priority  : 'personal_workflow' | 'coding_preference'   -- existing; personal_workflow is inviolable
-- convention payload (metadata/structured fields):
category  : 'architecture' | 'code_style' | 'testing' | 'workflow' | 'error_handling' | 'security' | 'gotcha' | 'other'   -- v1 enum; 'other' is the never-force-fit fallback
author    : who established it (attribution)
trigger   : { taskTypes?, technologies?, businessAreas?, fileGlobs?, summary }
steps     : ["...", "..."]                    -- the ordered A,B,C checklist
evidence  : [atomId | fileRef | docRef]       -- provenance; >=2 required for a distilled rule
confidence: number
```

### Migration
```sql
-- migrations/0NN_team_scope.sql  (mirrors 010_user_style_atoms.sql)
ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_scope_check,
  ADD  CONSTRAINT knowledge_atoms_scope_check CHECK (scope IN ('project','user','team')),
  ADD  COLUMN IF NOT EXISTS team_id text;

CREATE INDEX IF NOT EXISTS idx_atoms_scope_team
  ON knowledge_atoms (scope, team_id, tier) WHERE status='active';
```
**Team identity (v1):** a **single implicit team per Tuberosa instance** — `team_id` comes from config (`TUBEROSA_TEAM_ID`, default `"default"`). The export pack *is* "the team's book". Explicit multi-team membership is deferred.
Invariants (app-enforced, as user-style already does):
- `scope='project'` ⇒ `project_id` set, `user_id`/`team_id` null.
- `scope='user'` ⇒ `user_id` set, `project_id`/`team_id` null.
- `scope='team'` ⇒ `team_id` set, `project_id`/`user_id` null.

> **Modeling note (changed from brainstorm):** an earlier idea modeled "global" as a reserved `project: "__global__"` namespace on `StoredKnowledge`. Reading the shipped user-style spec, the canonical pattern is the `scope` discriminator on `knowledge_atoms`. Using `scope='team'` reuses one ranking pipeline, one critic/tier system, and the existing conflict policy, instead of overloading project identity. This supersedes the `__global__` idea.

## 6. The two views

### 6.1 Rules view (canonical)
Convention atoms flow through retrieval in a dedicated **conventions lane** that, like the existing `userStyle` lane, **bypasses `applyNamespaceFilter`** (so `team` conventions surface in any project). Atoms whose `trigger` matches the classified task (taskType ∩ technologies ∩ businessAreas ∩ fileGlobs) are **trigger-matched** and injected at the **front of `accepted`** in `context-pack.ts`, landing in the `essential` section as a checklist block. Non-matching conventions are excluded so the pack does not fill with irrelevant playbooks.

### 6.2 Handbook view (rendered)
A new deterministic atlas file **`conventions.md`** in `.tuberosa/atlas/`, generated by an `AtlasService` builder `(AtlasInputs) => string` exactly like the existing five files. It groups active convention atoms by `category`, shows each convention's `steps`, `author`, `scope` (badge: Personal / Team / Project), and links evidence. Pure function → golden-snapshot testable with `HashModelProvider`. The agent reads it via the existing atlas resource / `tuberosa_get_atlas`.

## 7. Lifecycle

### 7.1 Bootstrap (first-time init) — extends `tuberosa bootstrap`
Add a **convention-extraction stage** to the existing bootstrap command (and an MCP entry `tuberosa_bootstrap_handbook` for agents). The stage is **agent-driven**:
1. Tuberosa detects stack & structure (reuse the area-model + source-sync inputs bootstrap already gathers) and ingests existing docs (README/CONTRIBUTING/ADRs) — this part is deterministic.
2. Tuberosa returns to the calling agent: the detected stack, doc excerpts, and recurring-pattern hints, plus a **distillation instruction**.
3. The **agent** proposes draft conventions (each with `category`/`trigger`/`steps`/`author`/`scope`/`evidence`).
4. Drafts land as **reviewable reflection drafts** (governance #7) — one-time human confirmation, presented as a single digest ("Found N conventions across architecture / code-style / testing. Approve all · edit these · discard").

Bootstrap stays **safe and additive** (matches the existing bootstrap safety rules: no destructive cleanup, no silent overwrite). Convention extraction is non-fatal: a failed extraction never fails the sync/atlas portion of bootstrap.

### 7.2 Living — `tuberosa_propose_curation`
New MCP tool. The agent calls it when nudged. The **nudge fires from both `finish_session`** (natural point — the agent just produced atoms) **and `start_session`**, threshold-based and informational only (it never auto-runs curation; writes still pause per the automation policy). The agent calls it (nudged when atoms pile up):
1. Tuberosa pulls **un-curated atoms** (no `distilledIntoRuleId`), clusters related ones locally (reuse write-gate cosine + label-overlap math), returns clusters + a distillation instruction.
2. The agent writes back one distilled convention per worthy cluster via the existing `tuberosa_reflect` path (carrying the convention payload).
3. Source atoms are stamped `distilledIntoRuleId` (not re-clustered; demoted in ranking since the convention now represents them).
4. **Project-scoped** distilled rules with ≥2 evidence + passing gates **auto-activate**; **Team** promotion always lands as a draft.

### 7.3 Transfer
Team conventions (`scope='team'`) export via `tuberosa_export_pack` and import via `tuberosa_import_pack`; conflicts reuse `tuberosa_list_atom_import_conflicts` / `tuberosa_resolve_atom_import_conflict`.

## 8. Governance gate
Reuse the 12-gate evaluator (`src/reflection/recommendation.ts`) plus one new **`distillation_evidence`** hard gate:
- ≥2 distinct evidence sources (a rule generalizes; one atom is not a pattern),
- non-empty `trigger` and `steps`,
- non-duplicate vs existing conventions (write-gate),
- grounded references present.

Routing:
- **Project** convention, all gates pass, `learningMode='auto'` → **auto-activate**.
- **Team** convention (any) → **reviewable draft** → approval moves it to `scope='team'`.
- **Bootstrap** drafts (project or team) → **reviewable draft** (one-time confirmation).

## 9. Precedence & merge at recall
Collect all three lanes → dedup by `(category, topic)` → resolve conflicts:

1. **`personal_workflow` atoms are inviolable** — they win over everything (preserves guarantees like "no Claude co-author trailer"). Carried by the existing user-style priority field.
2. Otherwise **Project > Team > Personal `coding_preference`** (most-specific-wins).
3. The winning convention is kept; overridden ones are **annotated** in the pack `instruction` line ("project convention `spaces` overrides your personal `tabs`").
4. Non-conflicting Personal/Team conventions are **additive** (fill gaps the project is silent on).

## 10. Interaction design (ease of use)

**Human — 3 plain-English moments; nothing during work:**
| Moment | Human says | Effect |
|---|---|---|
| Set up (once) | "Tuberosa, learn this project" | Agent runs bootstrap → single approval digest |
| Read (anytime) | "Show me the project handbook" | Renders `conventions.md` + atlas |
| Share | "Share our handbook with the team" | One export pack; teammate imports with "load the team handbook" |

**Agent — rides tools it already calls:**
- `tuberosa_start_session` response gains a `handbook` field: `{ exists:false, suggestion:"run tuberosa_bootstrap_handbook" }` or `{ exists:true, summary, conventionCount }` with matched conventions **already pinned in the returned pack**. Zero extra calls in the common case.
- Two optional, nudged tools: `tuberosa_bootstrap_handbook`, `tuberosa_propose_curation`.

**Automation policy (#8):** auto-offer bootstrap / auto-read handbook / nudge curation; **pause for a human "yes" on every durable or shared write** (approving bootstrap drafts, promoting to team).

## 11. Architecture & touch points

```
src/conventions/            -- new module
  extract.ts                -- gather deterministic bootstrap inputs + build the agent distillation instruction
  curation.ts               -- cluster un-curated atoms (reuse write-gate math); build curation instruction
  merge.ts                  -- 3-layer precedence + conflict annotation (pure, eval-tested)
src/atlas/builders.ts       -- + conventions.md builder (pure (AtlasInputs)=>string)
src/reflection/recommendation.ts  -- + distillation_evidence gate
src/retrieval/service.ts    -- + conventions lane (bypasses applyNamespaceFilter, like userStyle)
src/retrieval/context-pack.ts     -- pin trigger-matched conventions to front of accepted
src/agent-session/service.ts      -- start_session response gains handbook status
src/mcp/server.ts + src/http/server.ts -- tuberosa_bootstrap_handbook, tuberosa_propose_curation
migrations/0NN_team_scope.sql     -- scope='team' + team_id
```

## 12. Eval coverage (required, failing-first per CLAUDE.md)
Add fixtures that fail without the change:
1. A cluster of ≥2 atoms distills to a convention with non-empty `trigger`/`steps`; a lone atom is **rejected** by `distillation_evidence`.
2. 3-layer merge resolves a style conflict **deterministically** (project wins) and emits the override annotation; a `personal_workflow` atom **wins over** a conflicting project convention.
3. A `team` convention surfaces in a **different** project's pack (lane bypass works) and is **pinned to `essential`**; a `project` convention does **not** leak across projects.
4. `conventions.md` golden snapshot is stable under `HashModelProvider`; handbook view matches the active convention set (no drift).
5. `pnpm run eval:retrieval` invariants (`hitRate=1`, `staleRejectionRate=1`, classification rates=1) stay green.

## 13. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Heuristic trigger-matching mis-fires | Tag-intersection v1; exclude non-matches from pinning; dedicated index deferred (Approach B). |
| Agent produces low-value conventions | `distillation_evidence` gate (≥2 evidence) + human review for team/bootstrap. |
| Team scope conflicts on import | Reuse existing atom import-conflict resolution. |
| Precedence breaks a personal-workflow guarantee | `personal_workflow` is inviolable (rule #1 in §9), covered by eval #2. |
| Bootstrap noise on huge repos | Extraction is additive, non-fatal, and review-gated; agent proposes, human approves. |

## 14. Resolved decisions (settled at spec review)
- **`category` enum (v1):** `{architecture, code_style, testing, workflow, error_handling, security, gotcha, other}` — `other` is the never-force-fit fallback; extend later.
- **Curation nudge:** fires from **both** `finish_session` and `start_session`, threshold-based and informational only (never auto-runs).
- **Team identity (v1):** single implicit team per Tuberosa instance via `TUBEROSA_TEAM_ID` config (default `"default"`); explicit multi-team deferred.
