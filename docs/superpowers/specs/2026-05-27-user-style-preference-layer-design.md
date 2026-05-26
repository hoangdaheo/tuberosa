# User-Style Preference Layer — Design (Concern F)

**Status:** Draft for review
**Date:** 2026-05-27
**Concern:** F in the six-concern decomposition (B → D → A → C → E → F)
**Depends on:** [B — Knowledge Atom Schema](2026-05-26-knowledge-atom-schema-design.md), [D — Write-Gate, Dedup, Decay](2026-05-26-write-gate-dedup-decay-design.md), [E — Project Export Bundle](2026-05-26-project-export-bundle-design.md)
**Author:** Brainstorming session with user

---

## 1. Problem

B's atoms are project-scoped: every atom belongs to exactly one project and is about that codebase. But the user has standing preferences that follow them across every project they touch — terse comments, no Claude co-author trailers, Conventional Commits, named exports, pnpm over npm, error-handling philosophy. Today these reset for every new project. The user has to re-teach each one, or accept that the agent gets the same wrong defaults every time.

Three concrete gaps:

1. **No user-scoped namespace.** All atoms live under a project; there's no place to store "this is about me, not this codebase."
2. **No capture path for personal style.** The agent extracts project lessons at `finish_session`; nothing routes personal preferences (which the agent already emits as `user_preference` learning signals in B) to a user-scoped destination.
3. **No conflict policy** for the inevitable case where the user's style and the project's convention disagree. A blanket "project wins" silently overrides personal-workflow preferences that should never be overridden ("no Claude co-author trailer"); a blanket "style wins" breaks codebase consistency on team projects.

## 2. Goal

Add a user-style atom layer that:

- Lives on the **same `knowledge_atoms` table** as project atoms via a `scope` discriminator and a `user_id` column — one critic, one tier system, one ranking pipeline.
- Surfaces in retrieval as a **separate candidate source** with its own weight, so the agent sees personal preferences alongside project knowledge but each ranks via its own policy.
- Is captured from four sources: explicit MCP/HTTP authoring, clustered `user_correction` feedback, clustered agent-output rejection feedback, and agent-emitted `user_preference` learning signals at `finish_session`.
- Resolves conflict with project conventions per a **per-atom priority field** (`personal_workflow` always wins; `coding_preference` yields to the project convention), with a clear pack `instruction` line either way.

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Team-level style (between user and project) | Future |
| Cross-user style merging ("inherit Bob's commit-message style") | Future |
| Style versioning beyond what tier demotion + new-atom creation already provides | Future |
| Visualizing user-style atoms in the workbench | UI follow-up |
| Auto-promoting user-style atoms from the agent's *self*-assessment of helpfulness | Future loop work; today only reuse promotes |
| Detecting style from cross-project `git log` scans | Spec deferred; not on the v1 critical path |

## 4. Scope and storage

User-style atoms live in `knowledge_atoms` alongside project atoms. A `scope` discriminator and `user_id` column distinguish them.

```sql
-- migrations/010_user_style_atoms.sql
ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'project'
    CHECK (scope IN ('project','user')),
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS priority text
    CHECK (priority IN ('personal_workflow','coding_preference'));

CREATE INDEX IF NOT EXISTS idx_atoms_scope_user
  ON knowledge_atoms (scope, user_id, tier) WHERE status='active';
```

**Invariants** (enforced in app code; the SQL CHECK is too awkward for a polymorphic table):

- `scope = 'project'` ⇒ `project_id IS NOT NULL ∧ user_id IS NULL ∧ priority IS NULL`
- `scope = 'user'` ⇒ `user_id IS NOT NULL ∧ project_id IS NULL ∧ priority IN ('personal_workflow','coding_preference')`

A single helper (`createUserStyleAtom`) is the only writer for `scope='user'` atoms, enforcing the invariants once.

## 5. The `priority` field

User-style atoms carry a mandatory `priority`:

- **`personal_workflow`** — about *you-the-person*, not the codebase. Inviolable. Wins on direct conflict with a project `convention` atom. Examples: commit-message style, no Claude co-author trailer, branch-naming, local tool choice.
- **`coding_preference`** — about *you-the-author-of-codebase*. Yields to project convention on direct conflict. Examples: comment density, named vs. default exports, error-handling style.

**Default:** `coding_preference` — the safer choice. Promotion to `personal_workflow` requires explicit human action (either the user explicitly authors with that priority, or a reviewer promotes a draft from `coding_preference` after review). Automatic capture sources (§7.b / §7.c / §7.d) **always** propose at `coding_preference`; the inferred path cannot create `personal_workflow` atoms.

## 6. Critic adjustments for `scope='user'`

The 4-stage critic from D runs unchanged, with three small adjustments when `scope='user'`:

1. **Skip cross-type dedup against legacy `knowledge_items`** (D §7). User style is its own namespace; deduping against project-scoped memories or wikis is wrong.
2. **Atom-vs-atom dedup is per-user.** The cosine ≥ 0.92 check from D runs only against other user-style atoms with the same `user_id`. A project atom asserting "use HNSW" must not dedup against a user-style atom asserting the same — they live in different namespaces by design.
3. **Triviality stop-list extended** with one new rule: `personal_pronoun_only` rejects atoms whose claim is bare ego — anchored at start AND end: `/^(i\s+(am|like|love|hate|feel)|i'm|my)\s+[^.]{0,40}\.?$/i`. Real style preferences contain a verb and an object beyond "I" — bare "I'm the best" is rejected.

The triviality extension lives in `src/atoms/triviality-rules.ts` as a rule activated only when `scope='user'`.

### 6.a — Relaxed evidence floor for user-style

Many style preferences ("I prefer named exports") have no single file to point to. For `scope='user'`:

- The "≥ 1 evidence pointer" floor still applies, but a `prior_session` evidence pointer is **auto-inserted** when the user calls `tuberosa_record_user_style` inside an active session. The current `sessionId` becomes the pointer.
- If the user calls the tool **outside** any session, evidence remains required from the caller. If the caller doesn't supply any, the critic falls back to creating the atom with a `low_evidence: true` flag in metadata; that atom's starting tier multiplier is halved until reuse promotes it. (The atom still passes the floor — `low_evidence` is a metadata signal, not a rejection.)

## 7. Capture sources

### 7.a — Explicit authoring

```
tuberosa_record_user_style({
  userId?: string,                          // default TUBEROSA_USER_ID env
  claim: string,
  type: 'convention' | 'gotcha' | 'decision' | 'fact',
  priority?: 'personal_workflow' | 'coding_preference',  // default 'coding_preference'
  trigger: { taskTypes?, files?, symbols?, intentTags? },
  evidence?: Evidence[],
  pitfalls?: string[],
})
  → KnowledgeAtom (scope='user')
```

`type` is restricted: `procedure` is rejected because multi-step procedures rarely belong as cross-project user style (those belong as project workflows or wikis). The MCP tool validates this and surfaces a helpful error.

HTTP mirror: `POST /user-style-atoms` with the same body.

Workbench surface: a "My style" section in the workbench renders the user's atoms, with an "Add style preference" form that walks the user through the `priority` choice.

### 7.b — Inferred from `user_correction` clusters

A background job (`pnpm run cluster-user-corrections`, default every 60 minutes):

1. Reads `feedback_events` of type `selected_but_noisy`, `rejected`, `irrelevant`, AND `agent_sessions.context_decisions` of type `user_correction` filtered to the configured user from the last `TUBEROSA_USER_STYLE_CLUSTER_WINDOW_DAYS` (default 30).
2. Embeds each event's reason/text via `ModelProvider.embed` and clusters by cosine ≥ 0.85 (single-link greedy).
3. When a cluster has ≥ `TUBEROSA_USER_STYLE_MIN_CLUSTER_EVENTS` (default 3) members, creates a `learning_proposal` row of type `user_style_candidate`. The proposal includes the cluster's centroid claim summary (from a small LLM call when a provider is available, or a deterministic top-tokens summary as fallback) and the raw quotes.
4. The proposal lands in the existing reflection-draft review queue (alongside D's proposals). Reviewer approval creates the atom at `priority='coding_preference'`.

### 7.c — Inferred from repeated agent-output rejections

Same machinery as 7.b, seeded from `feedback_events` where the *agent's output* was rejected (`metadata.rejectionTarget = 'agent_output'`). The proposal's claim describes what to avoid, and the cluster's quotes go into `pitfalls`.

### 7.d — Agent-emitted `user_preference` learning signals

`tuberosa_finish_session` already accepts `learningSignals` with `kind='user_preference'`. F routes those signals through a new path:

1. The signal text becomes a candidate claim.
2. The candidate runs through the 4-stage critic with `scope='user'`.
3. On pass, the atom lands at `tier='draft'`, `priority='coding_preference'`, and surfaces in the workbench review queue.
4. On rejection, a `knowledge_gap` row is created with `metadata.source='user_style_critic'` so the failed extraction is observable.

This is the "ask agent for feedback / lessons learned" capture path. It piggybacks on infrastructure that already exists in B — F just gives the signal a destination.

## 8. Retrieval integration

User-style atoms join the existing pipeline as a **separate candidate source**:

```typescript
// In findCandidates(), alongside metadata/lexical/memory/vector/graph/worktree:
const userStyleResults = await this.store.searchAtomsByTrigger(
  {
    taskTypes: classified.taskType ? [classified.taskType] : undefined,
    files: classified.files,
    symbols: classified.symbols,
  },
  {
    project: undefined,
    scope: 'user',
    userId: this.config.userId,
    limit: SEARCH_LIMIT,
  },
);
```

Two policy values added to `retrieval-policy.json`:

```jsonc
{
  "sourceWeights": {
    "userStyle": 0.12
  },
  "userStyle": {
    "tierMultipliers": {
      "draft":     0.4,
      "verified":  0.8,
      "canonical": 1.1
    },
    "personalWorkflowBoost": 1.3
  }
}
```

The `personalWorkflowBoost` is applied multiplicatively when `priority='personal_workflow'`. Inviolable preferences earn a stronger pull at rank time, on top of the conflict policy in §9.

User-style atoms get a `matchReasons` prefix of `userStyle:<priority>:` (e.g. `userStyle:personal_workflow:`) so the agent and the workbench can see the provenance and decide.

## 9. Conflict resolution

**Definition of "direct conflict":** a user-style atom and a project `convention` atom both fire for the same query trigger AND their claims are semantically opposite. Detection is conservative:

- Negation: one contains a negation verb (`not`, `never`, `avoid`, `don't`) where the other does not, on the same noun phrase.
- Embedding contrast: `cosine(embed(userClaim), embed(projectClaim)) ≤ -0.2` after mean-centering the project's corpus.

If either heuristic fires, the pair is a conflict candidate. Both heuristics fire = high confidence; one fires = surface as conflict but log it for human review.

**Resolution:**

```
on conflict between user-style atom U and project convention atom P:
  if U.priority == 'personal_workflow':
      surface U; suppress P for this query
      record SuppressionEvent { reason: 'user_personal_workflow', losingId: P.id }
      pack.instruction += "Following your personal workflow: <U.claim>"
  else (U.priority == 'coding_preference'):
      surface P; suppress U for this query
      record SuppressionEvent { reason: 'project_convention_wins', losingId: U.id }
      pack.instruction += "Project convention: <P.claim>. Your usual preference <U.claim> is parked for this codebase."
```

Both branches make the override **visible** in the pack. The agent never has to guess which won; the user can correct course.

## 10. Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_USER_ID` | _empty_ | Identifies the current user. When unset, F features are no-ops. |
| `TUBEROSA_USER_STYLE_ENABLED` | `true` | Master switch. |
| `TUBEROSA_USER_STYLE_CLUSTER_INTERVAL_HOURS` | `1` | Clustering job cadence. |
| `TUBEROSA_USER_STYLE_MIN_CLUSTER_EVENTS` | `3` | Cluster size to trigger a proposal. |
| `TUBEROSA_USER_STYLE_CLUSTER_WINDOW_DAYS` | `30` | Time window for cluster eligibility. |
| `retrieval-policy.json` → `sourceWeights.userStyle` | `0.12` | Fusion weight. |
| `retrieval-policy.json` → `userStyle.tierMultipliers` | per §8 | Tier-based rank multipliers, separate from project atoms. |
| `retrieval-policy.json` → `userStyle.personalWorkflowBoost` | `1.3` | Multiplicative boost for `personal_workflow` priority. |

## 11. Export integration with E

User-style atoms are **excluded from project export by default** — they're personal. Two opt-ins:

- `pnpm run export-pack -- --include-user-style=<userId>` writes the named user's style atoms under `user-style/<userId>/<slug>-<short-id>.md`. The manifest gains `userStyleScopes: [<userId>]`.
- On import, user-style atoms always land at `tier='draft'` and `priority='coding_preference'` (the safer default) regardless of source. The importer can be passed `--preserve-user-id` to keep the bundle's `userId`, otherwise it rewrites to the importing user's id (so importing your teammate's style starts it as *yours-at-draft* until you decide otherwise).

This lets a teammate share style as a starting point without forcing the receiver to inherit `personal_workflow` overrides. A teammate's "always use Conventional Commits" comes in as `coding_preference` on your machine; you promote it to `personal_workflow` if you agree.

## 12. Acceptance criteria

- ✅ `tuberosa_record_user_style({ userId, claim, type, priority, trigger })` creates an atom with `scope='user'`, `user_id` populated, `project_id` null, and the requested `priority`.
- ✅ Calling with `type='procedure'` is rejected with a helpful error.
- ✅ Critic skips cross-type legacy dedup for user-style atoms; runs triviality (including the new `personal_pronoun_only` rule), schema floor, atom-vs-atom dedup against the same user's other atoms, and LLM critic.
- ✅ The clustering job, given ≥ 3 `user_correction` events with similar text, creates one `user_style_candidate` learning proposal, defaulting to `priority='coding_preference'`.
- ✅ `finish_session` with a `learningSignal{kind:'user_preference'}` results in a user-style draft (or a `knowledge_gap` if the critic rejects).
- ✅ Retrieval with `TUBEROSA_USER_ID` set surfaces matching user-style atoms with `matchReasons` containing `userStyle:<priority>:`.
- ✅ When a project `convention` atom directly conflicts with a `personal_workflow` user-style atom on the same trigger, the user-style atom wins and `pack.instruction` mentions the personal-workflow override.
- ✅ When a project `convention` atom directly conflicts with a `coding_preference` user-style atom, the project atom wins and `pack.instruction` parks the user preference for this codebase.
- ✅ `export-pack` excludes user-style atoms by default; `--include-user-style=<id>` writes them under `user-style/<id>/`.
- ✅ Setting `TUBEROSA_USER_STYLE_ENABLED=false` disables all F features cleanly without breaking the rest of retrieval.

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| User-style atoms drown out project knowledge on similar triggers. | Lower `sourceWeights.userStyle` (default 0.12) and tier multipliers; conflict resolution surfaces overrides explicitly. All knobs in policy. |
| Clustering produces noisy proposals because corrections cluster on surface text rather than intent. | Proposals are review-queued, not auto-promoted. Reviewer sees raw quotes. Cluster threshold and window are policy values. |
| `personal_pronoun_only` rejects a legitimate style atom that happens to start with "I". | Rule is anchored at start AND end (`/^… [^.]{0,40}\.?$/i`); it only fires on bare-ego claims. Fixture cases pin both positive and negative examples. |
| The `personal_workflow` boost lets a user atom hide a project convention the user *should* be following. | Conflict resolution always writes a `SuppressionEvent` AND surfaces the override in `pack.instruction`. The agent sees and can prompt the user. If misuse is detected via feedback, demotion to `coding_preference` is one workbench click. |
| Multiple users on the same Tuberosa need clear isolation. | `user_id` is the only key; queries filter by `TUBEROSA_USER_ID`. No cross-user leak unless explicit `export --include-user-style`. |
| Evidence-floor relaxation could be exploited to write empty style atoms. | Auto-inserted `prior_session` evidence + `low_evidence` metadata + halved starting tier multiplier. Reuse signal still validates them. |
| Negation/embedding-contrast heuristic for "direct conflict" misfires. | When only one heuristic fires, the conflict surfaces but is logged for human review rather than enforced silently. False positives create a workbench triage item, not user-facing disruption. |
| Capture from `user_preference` learning signals invites the agent to fabricate preferences. | All paths land at `tier='draft'` and `priority='coding_preference'`. Promotion to `personal_workflow` requires an explicit human action — the agent cannot escalate. |

## 14. Next steps

1. User reviews this spec.
2. After approval, write the F implementation plan.
3. With all six specs (B, D, A, C, E, F) and seven plans (B, D, A, C1, C2, E, F) committed, the brainstorming phase closes. Recommended execution order honoring the dependency chain: **B → D → A → C1 → C2 → E → F**.
