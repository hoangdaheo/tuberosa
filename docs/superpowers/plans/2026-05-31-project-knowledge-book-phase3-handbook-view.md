# Project Knowledge-Book — Phase 3 (Handbook View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Fresh-session note:** You need only this file + the master spec (`docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md`, §6.2) + the repo. Phases 1 & 2 already shipped (`scope:'team'`, `teamId`, the convention retrieval lane, pinning, `resolveLayeredConflicts`, `start_session.handbook`). Branch off the latest knowledge-book branch (currently `feat/knowledge-book-phase2`) or `main` once those are merged.

**Goal:** Render the project's `type:'convention'` atoms as a readable `conventions.md` handbook, generated deterministically alongside the existing atlas files and exposed via `tuberosa_get_atlas`.

**Architecture:** The atlas (`src/atlas/`) already gathers ALL atoms into `AtlasInputs.atoms` and renders 5 deterministic Markdown files via a `BUILDERS` array of pure `(AtlasInputs) => string` functions. Add a 6th builder `buildConventions` that filters `inputs.atoms` to active conventions, groups them by `scope` then `metadata.category` (fallback `'other'`), and renders claim + scope/layer badge + tier + steps + evidence. It auto-wires into `AtlasService.regenerate()` and `tuberosa_get_atlas` with no other changes. Pure → golden-snapshot testable with `HashModelProvider`.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes; tests import `.js`), `node --test` + `tsx`.

> **Before coding:** `npx gitnexus analyze`. This phase does NOT touch retrieval ranking, but still run `pnpm run build && pnpm test` at the end; `pnpm run eval:retrieval` should remain green (untouched).

---

### Task 1: `buildConventions` atlas builder

**Files:**
- Modify: `src/atlas/builders.ts` (the `BUILDERS` array ~lines 22-28; add `buildConventions` + export)
- Test: `test/atlas-conventions.test.ts`

**Read first:** `src/atlas/builders.ts` in full — copy the style of an existing builder (e.g. `buildOpenGaps` / `buildProjectMap`): how they read `inputs`, format Markdown headings, sort deterministically, and handle empty input. Also read `src/atlas/inputs.ts:11-25` (the `AtlasInputs` type — note `atoms: KnowledgeAtom[]` is already present) and `src/types/atoms.ts:48-77` (`KnowledgeAtom`: `claim`, `type`, `scope`, `tier`, `status`, `evidence`, `metadata?`).

- [ ] **Step 1: Write the failing test** at `test/atlas-conventions.test.ts`. Read `test/atlas-builders.test.ts` first to copy the `emptyInputs(...)`/`gatherAtlasInputs` helper and the snapshot/`assert.match` pattern. Cases:
  1. Determinism: `buildConventions(i) === buildConventions(i)` for inputs containing a couple of convention atoms.
  2. A `scope:'team'` convention with `metadata.category:'code_style'` renders under a Team / Code Style grouping and shows its claim.
  3. A convention with NO `metadata.category` renders under an `other`/`Uncategorized` group (no crash).
  4. Non-convention atoms (`type:'fact'`) and `status!=='active'` conventions are excluded.
  5. Empty input (no conventions) yields a stable "no conventions captured yet" placeholder string (so the file always exists).

  Construct atoms via the same inputs helper the existing test uses (or `MemoryKnowledgeStore.createAtom` + `gatherAtlasInputs`). Run it — confirm FAIL (`buildConventions` not exported).

- [ ] **Step 2: Implement `buildConventions`** in `src/atlas/builders.ts`, mirroring the existing builders' formatting helpers. Reference implementation (adapt headings/escaping to match sibling builders exactly):

```typescript
export function buildConventions(inputs: AtlasInputs): string {
  const conventions = inputs.atoms
    .filter((a) => a.type === 'convention' && a.status === 'active')
    .slice()
    .sort((l, r) => l.id.localeCompare(r.id)); // deterministic

  const lines: string[] = ['# Conventions', '', `> Synthesized from input PENDING. ${conventions.length} active convention(s).`, ''];
  if (conventions.length === 0) {
    lines.push('No conventions captured yet. Run `tuberosa_bootstrap_handbook` or `tuberosa_propose_curation` to extract them.');
    return `${lines.join('\n')}\n`;
  }

  const scopeOrder: Array<'project' | 'team' | 'user'> = ['project', 'team', 'user'];
  const scopeLabel: Record<string, string> = { project: 'Project', team: 'Team', user: 'Personal' };
  for (const scope of scopeOrder) {
    const inScope = conventions.filter((a) => a.scope === scope);
    if (inScope.length === 0) continue;
    lines.push(`## ${scopeLabel[scope]}`, '');
    // group by category (deterministic order)
    const categories = [...new Set(inScope.map((a) => String((a.metadata as Record<string, unknown> | undefined)?.category ?? 'other')))].sort();
    for (const category of categories) {
      lines.push(`### ${category}`, '');
      for (const a of inScope.filter((x) => String((x.metadata as Record<string, unknown> | undefined)?.category ?? 'other') === category)) {
        const author = (a.metadata as Record<string, unknown> | undefined)?.author;
        lines.push(`- **${a.claim}** _(tier: ${a.tier}${author ? `, by ${String(author)}` : ''})_`);
        const steps = (a.metadata as Record<string, unknown> | undefined)?.steps;
        if (Array.isArray(steps)) {
          for (const [i, step] of steps.entries()) lines.push(`  ${i + 1}. ${String(step)}`);
        }
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
```
> Note the `input PENDING` token: `AtlasService.regenerate` replaces it with the input hash (see service.ts:55). Match whatever the sibling builders emit for that line; if they don't use the token, drop it.

- [ ] **Step 3: Register the builder.** Add to the `BUILDERS` array (builders.ts ~22-28):
```typescript
  { name: 'conventions.md', build: buildConventions },
```

- [ ] **Step 4: Run the test — PASS.** Then `pnpm run build && pnpm test`. Build clean; all tests pass. (`AtlasService.regenerate` and `tuberosa_get_atlas` auto-include the new file — verify by reading `src/mcp/server.ts:546-559` + schema 1638-1649; no edit needed since `file=conventions.md` filters the contents array.)

- [ ] **Step 5: Commit** (NO AI-attribution trailer):
```bash
git add src/atlas/builders.ts test/atlas-conventions.test.ts
git commit -m "feat(atlas): conventions.md handbook view from convention atoms"
```

---

### Task 2: Wire-through verification + (optional) atlas-run accounting

**Files:**
- Verify: `src/atlas/service.ts` (`regenerate` ~36-63), `src/mcp/server.ts` (`tuberosa_get_atlas` ~546-559, schema ~1638-1649)
- Modify (only if needed): the `tuberosa_get_atlas` description string (mention conventions.md)

- [ ] **Step 1:** Add a test (or extend an existing atlas-service test) asserting `AtlasService.regenerate({...,write:false})` returns a `contents` entry named `conventions.md`. Read existing atlas-service tests first.
- [ ] **Step 2:** Update the `tuberosa_get_atlas` schema/description (server.ts:1638-1649) to list `conventions.md` among the files, so clients discover it. One-line description edit.
- [ ] **Step 3:** `pnpm run build && pnpm test` green.
- [ ] **Step 4: Commit:**
```bash
git add src/mcp/server.ts test/*.test.ts
git commit -m "docs(atlas): surface conventions.md in get_atlas tool description"
```

---

## Phase 3 Definition of Done
- `buildConventions` renders active `type:'convention'` atoms grouped by scope→category, tolerant of missing category/steps/author, with a stable empty-state.
- Registered in `BUILDERS`; `tuberosa_get_atlas` (incl. `file=conventions.md`) returns it; `AtlasService.regenerate` writes `.tuberosa/atlas/conventions.md`.
- Golden-snapshot deterministic under `HashModelProvider`.
- `pnpm run build && pnpm test` green; `pnpm run eval:retrieval` still green (untouched).

## Notes / risks
- Until Phase 4 populates `metadata.category/steps/author`, conventions render under `other` with just claim+tier — acceptable; the view degrades gracefully.
- Keep the builder PURE (no store calls, no Date.now) — determinism is the eval contract for the atlas.
