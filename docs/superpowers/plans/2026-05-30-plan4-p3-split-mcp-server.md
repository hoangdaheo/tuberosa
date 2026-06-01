# P4-3 — Split mcp/server.ts (extract pure definitions/helpers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Shrink `src/mcp/server.ts` (1815 lines) by extracting the large pure-data/pure-function pieces — the tool-definitions array, the prompt definitions, and the arg-coercion/JSON helpers — into focused modules, **without touching the dispatch switch** (preserving exact tool routing, arg validation, and MCP stdout-protocol-only discipline).

**Architecture:** Move pure functions/data to new modules and import them back. `handleMcpRequest`/`callTool`/`readResource` (the dispatch + handlers) stay in `server.ts`. Lowest-risk high-impact split: no behavioral change, the wire contract is byte-identical.

**Tech Stack:** TypeScript (NodeNext), `node --test`.

**Branch:** `refactor/plan4-split-mcp-server` (created, stacked on `refactor/plan4-split-postgres-store`).

**Verify gate:** `pnpm run build && pnpm test` after each task; the wire-contract guards are `test/api-boundary.test.ts`, `test/invariants.test.ts` (MCP stdout-only), and `test/mcp-stdio-fuzz.test.ts`.

## Constraints
- **Do NOT change** `handleMcpRequest`, `callTool`'s switch, or any tool name / arg validation / response shape.
- **No `console.*`** anywhere reachable from the MCP path (the invariants test enforces stdout = JSON-RPC only).
- Pure moves only: cut a function/array out, paste verbatim into the new module with `export`, import it back. Adjust only imports.
- `test/invariants.test.ts` mcp-stdio frame test is a known load-timing flake — if it fails in a full run, re-run it in isolation to confirm it passes.

---

## Task 1: Extract the tool-definitions array → `src/mcp/tool-definitions.ts`

**What:** `tools()` (server.ts ~956-1652) is a ~700-line function returning the static array of tool definitions (name + inputSchema). Move it verbatim.

**Files:** Create `src/mcp/tool-definitions.ts`; Modify `src/mcp/server.ts`.

- [ ] **Step 1: Read `tools()` fully** (956 to its closing brace ~1652) and note any module-scope identifiers it references (e.g. `learningSignalSchema()` at 657). If it calls `learningSignalSchema`, move that too (or import it). List every external reference.
- [ ] **Step 2: Create `src/mcp/tool-definitions.ts`:**
```typescript
// Static MCP tool definitions (name + inputSchema). Pure data — no runtime behavior.
export function tools() {
  return [ /* …the exact array, verbatim… */ ];
}
// move learningSignalSchema() here too if tools() is its only caller; else import it.
```
- [ ] **Step 3: In `server.ts`** delete `tools()` (and `learningSignalSchema` if moved) and `import { tools } from './tool-definitions.js';`. The call site (`tools/list` handler) is unchanged.
- [ ] **Step 4: Verify** — `pnpm run build && node --test --import tsx test/api-boundary.test.ts 2>&1 | tail -5`. The api-boundary test asserts the tool list/schemas — must stay green.
- [ ] **Step 5: Commit:** `git add src/mcp/tool-definitions.ts src/mcp/server.ts && git commit -m "refactor(mcp): extract tool-definitions to its own module"`

---

## Task 2: Extract prompts → `src/mcp/prompts.ts`

**What:** `prompts()` (~1653) and `getPrompt(params)` (~784) are the prompt registry + getter. Move both verbatim.

**Files:** Create `src/mcp/prompts.ts`; Modify `src/mcp/server.ts`.

- [ ] **Step 1: Read `prompts()` and `getPrompt()`** + any helpers they reference. If `getPrompt` references constants defined elsewhere in server.ts, move/import them.
- [ ] **Step 2: Create `src/mcp/prompts.ts`** exporting `prompts()` and `getPrompt(params: Record<string, unknown>)` verbatim.
- [ ] **Step 3: Import both back** in `server.ts` (`prompts/list` and `prompts/get` handlers unchanged); delete the originals.
- [ ] **Step 4: Verify** — `pnpm run build && pnpm test 2>&1 | tail -5` (full suite; if invariants mcp-stdio flakes, re-run it alone).
- [ ] **Step 5: Commit:** `git commit -m "refactor(mcp): extract prompt registry to prompts module"`

---

## Task 3: Extract arg-coercion + JSON helpers → `src/mcp/helpers.ts`

**What:** The small pure helpers: `readRequiredMcpString`, `readOptionalMcpString`, `readMcpStringArray`, `readToolName`, `readToolArguments`, `readString`, `readStringArray`, `toolJson`, `resourceJson`, `readProtocolVersion`. Move verbatim.

**Files:** Create `src/mcp/helpers.ts`; Modify `src/mcp/server.ts`.

- [ ] **Step 1: Read each helper** (they're tiny, near lines 139, 919-939, 1766-1811). Confirm they're pure (no closure over server.ts state). Confirm none use `console.*`.
- [ ] **Step 2: Create `src/mcp/helpers.ts`** exporting all of them verbatim.
- [ ] **Step 3: Import them back** in `server.ts`; delete the originals. (Many call sites — verify the build catches any missed import.)
- [ ] **Step 4: Verify** — `pnpm run build && pnpm test 2>&1 | tail -5`.
- [ ] **Step 5: Commit:** `git commit -m "refactor(mcp): extract arg-coercion and json helpers"`

---

## Task 4: Final verification

- [ ] **Step 1:** `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context`.
- [ ] **Step 2:** `wc -l src/mcp/server.ts` — confirm a large reduction (target < ~1000 lines).
- [ ] **Step 3: MCP stdout discipline** — `grep -rn "console.log\|process.stdout" src/mcp/ src/mcp/tool-definitions.ts src/mcp/prompts.ts src/mcp/helpers.ts` → must be empty. Run `node --test --import tsx test/invariants.test.ts` (in isolation) and `test/mcp-stdio-fuzz.test.ts` — both green.
- [ ] **Step 4:** Confirm no tool name/schema changed: `node --test --import tsx test/api-boundary.test.ts` green.

---

## Self-Review (plan author)
- **Coverage:** extracts the three large pure pieces (tool defs ~700L, prompts, helpers); dispatch switch + handlers untouched → zero behavioral risk, wire contract identical.
- **Risk:** low — pure moves; build + api-boundary + invariants + fuzz tests guard tool routing, schemas, and stdout discipline.
- **Not exhaustive:** `callTool`'s per-domain handler split is deliberately deferred (it touches dispatch; higher risk). This pass targets the highest-line-count, lowest-risk extractions. The remaining `callTool`/`readResource` can be split in a follow-up if desired.
