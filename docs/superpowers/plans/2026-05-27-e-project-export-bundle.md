# Project Export Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a portable `.tuberosa-pack/` bundle — markdown atoms + knowledge (human-editable), `edges.jsonl`, optional chunks, `manifest.json` with integrity hashes — plus the export and import commands, conflict-resolution surface, and workbench tab.

**Architecture:** New `src/export/` module handles bundle read/write through three layers: (a) **codec** (atom/knowledge YAML-frontmatter Markdown parser + serializer, edges JSONL streamer), (b) **export pipeline** that pulls items from the store, runs them through `KnowledgeSafetyService`, and writes the directory tree, (c) **import pipeline** that parses incoming files and reconciles per spec §9 (atoms → human review, edges → auto-merge max confidence). A new `atom_import_conflicts` table backs the conflict review queue, surfaced via HTTP + MCP + workbench.

**Tech Stack:** TypeScript (Node 22), `js-yaml` (already a dependency or to be added — verify in task 1), `node:test` runner with `tsx`, existing `KnowledgeStore` + `KnowledgeSafetyService`.

**Spec:** [`docs/superpowers/specs/2026-05-26-project-export-bundle-design.md`](../specs/2026-05-26-project-export-bundle-design.md)

**Depends on:** B, D, C1, C2 plans must be merged first (atoms and edges must exist; safety redaction is required at export).

## Status

**Completed — 2026-05-28** on branch `feat/project-export-bundle` (off `feat/graph-c2-read-side`).

### Deviations from spec/plan

1. **Task 3 (atom codec) — `atomFilename` slug rule.** The plan's literal implementation
   (`split(/\W+/)`, `slice(0, 8)`) does not produce the slug pattern asserted by the
   plan's own test (`pgvector-column-dim-must-equal-embedding-dimensions-bf3a.md`).
   Shipped impl uses `split(/[\W_]+/)` (so `EMBEDDING_DIMENSIONS` → `embedding`,
   `dimensions`) and `slice(0, 7)`. Same change applied to `knowledgeFilename`.
   Trade-off: marginal cosmetic divergence from a literal reading of the plan, but
   matches the asserted regex and yields nicer slugs.

2. **Task 8 (importer) — id-preserving create path.** Plan calls `store.createAtom`
   then `store.getAtom(incoming.id)`. Memory and Postgres `createAtom` previously
   minted a new UUID, so this would never find the imported record. Added an
   optional `id?: string` to `KnowledgeAtomInput` and honored it in both stores.
   The id-conflict test asserts the round-trip uses the original id, proving the
   change is load-bearing.

3. **Task 10 (round-trip eval fixture).** Plan calls for adding a `roundTrip`
   case to `eval/retrieval-fixtures.json` and extending the deterministic
   retrieval evaluator. The evaluator currently has a tight per-case contract
   (`hitRate=1`, strict classification checks) and adding a special-case branch
   would obscure failures of the main fixture. Instead, shipped
   `test/export-roundtrip-retrieval.test.ts` asserts the same invariant
   (search reaches the imported atom after export+import). Counted by `pnpm test`.
   Follow-up to integrate into the eval runner remains open.

4. **Task 9 — `src/config.ts` env variables.** Plan mentions
   `TUBEROSA_EXPORT_*` and `TUBEROSA_IMPORT_DEFAULT_CONFLICT_POLICY`; not added.
   The CLI flags and HTTP/MCP request bodies cover every knob the exporter
   exposes, and there is no caller that benefits from a global default at this
   stage. Trivial to add later if needed.

### Verification

- `pnpm run build`: green.
- `pnpm test`: 552 tests pass.
- `pnpm run eval:retrieval`: 100% hit, MRR 1.0, classification 100%.
- `pnpm run export-pack --project tuberosa --out /tmp/tpack`: emits manifest, atoms/, knowledge/, edges.jsonl, README.md.
- `pnpm run import-pack --from /tmp/tpack --dry-run`: counts reported, no mutations.

---

## File Structure

**Create:**
- `migrations/009_atom_import_conflicts.sql` — conflict-review table
- `src/types/export-bundle.ts` — `BundleManifest`, `AtomFrontmatter`, `KnowledgeFrontmatter`, `BundleEdge` shapes
- `src/export/atom-codec.ts` — parse + serialize atom Markdown files
- `src/export/knowledge-codec.ts` — parse + serialize knowledge Markdown files
- `src/export/edges-codec.ts` — read + write `edges.jsonl`
- `src/export/manifest.ts` — manifest read/write + integrity hashing
- `src/export/exporter.ts` — orchestrates export
- `src/export/importer.ts` — orchestrates import with conflict detection
- `src/export/readme-template.ts` — emits the README.md inside each pack
- `scripts/export-pack.ts` — CLI entry
- `scripts/import-pack.ts` — CLI entry
- `src/operations/atom-import-conflicts.ts` — service for listing + resolving conflicts
- `test/export-codec-atom.test.ts`
- `test/export-codec-knowledge.test.ts`
- `test/export-codec-edges.test.ts`
- `test/export-exporter.test.ts`
- `test/export-importer.test.ts`
- `test/export-importer-conflicts.test.ts`

**Modify:**
- `src/storage/store.ts` — `createAtomImportConflict`, `listAtomImportConflicts`, `getAtomImportConflict`, `resolveAtomImportConflict`
- `src/storage/memory-store.ts` — impls
- `src/storage/postgres-store.ts` — impls
- `src/http/server.ts` — `POST /operations/import-pack`, `GET/POST /operations/atom-import-conflicts*`
- `src/mcp/server.ts` — `tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_atom_import_conflicts`, `tuberosa_resolve_atom_import_conflict`
- `src/config.ts` — `TUBEROSA_EXPORT_*` and `TUBEROSA_IMPORT_DEFAULT_CONFLICT_POLICY`
- `package.json` — `export-pack`, `import-pack` scripts + (verify) `js-yaml` dependency
- `eval/retrieval-fixtures.json` — round-trip fixture: export-then-import yields identical search results

---

## Task 1: Migration + js-yaml dependency

**Files:**
- Create: `migrations/009_atom_import_conflicts.sql`
- Modify: `package.json`

- [x] **Step 1: Create the migration**

Create `migrations/009_atom_import_conflicts.sql`:

```sql
CREATE TABLE IF NOT EXISTS atom_import_conflicts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  atom_id           uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  local_snapshot    jsonb NOT NULL,
  imported_snapshot jsonb NOT NULL,
  bundle_source     text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved_keep_local','resolved_take_imported','resolved_merged','dismissed')),
  resolution_notes  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_atom_import_conflicts_status
  ON atom_import_conflicts(project_id, status, created_at DESC);
```

- [x] **Step 2: Verify or add js-yaml**

Run: `grep '"js-yaml"' package.json || echo 'missing'`

If `missing`, install:

```bash
pnpm add js-yaml
pnpm add -D @types/js-yaml
```

- [x] **Step 3: Apply migration**

Run: `pnpm run migrate`
Expected: `applied 009_atom_import_conflicts.sql`.

- [x] **Step 4: Commit**

```bash
git add migrations/009_atom_import_conflicts.sql package.json pnpm-lock.yaml
git commit -m "feat(export): migration 009 atom_import_conflicts + js-yaml dep"
```

---

## Task 2: Bundle types

**Files:**
- Create: `src/types/export-bundle.ts`
- Modify: `src/types.ts`

- [x] **Step 1: Create types**

Create `src/types/export-bundle.ts`:

```typescript
import type { KnowledgeAtom, AtomTier, AtomStatus, AtomType, Evidence, Trigger, Verification, AtomLink } from './atoms.js';

export interface BundleManifest {
  schemaVersion:   number;
  project:         string;
  generated:       string;
  sourceCommit?:   string;
  tuberosaVersion?: string;
  counts:          { atoms: number; knowledge: number; edges: number; chunks: number };
  integrity:       Record<string, string>;     // file → "sha256:..."
  tierPolicy:      { exportedTiers: AtomTier[]; excludedStatuses: AtomStatus[] };
  includesChunks:  boolean;
  safetyRedactionVersion: string;
  notes?:          string;
}

export interface AtomFrontmatter {
  id:        string;
  revision:  number;
  project:   string;
  type:      AtomType;
  tier:      AtomTier;
  status:    AtomStatus;
  trigger:   Trigger;
  evidence:  Evidence[];
  verification?: Verification;
  pitfalls?: string[];
  links?:    AtomLink[];
  audit:     { producedBy: string; producedAtSessionId?: string; createdAt: string; updatedAt: string };
  claim?:    string;                          // optional override; default is the body
}

export interface KnowledgeFrontmatter {
  id:        string;
  project:   string;
  itemType:  'wiki' | 'spec' | 'code_ref' | 'workflow' | 'rule' | 'conversation';
  title:     string;
  labels:    Array<{ type: string; value: string; weight?: number }>;
  references: Array<{ type: string; uri: string; lineStart?: number; lineEnd?: number }>;
  trustLevel: number;
  audit:     { createdAt: string; updatedAt: string };
}

export interface BundleEdge {
  from:            string;
  to:              string;
  kind:            'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';
  confidence:      number;
  inferenceSource: 'migration' | 'semantic' | 'co_change' | 'refines_detector' | 'manual';
}

export interface AtomImportConflict {
  id:                string;
  project:           string;
  atomId:            string;
  localSnapshot:     KnowledgeAtom;
  importedSnapshot:  AtomFrontmatter & { body: string };
  bundleSource:      string;
  status:            'open' | 'resolved_keep_local' | 'resolved_take_imported' | 'resolved_merged' | 'dismissed';
  resolutionNotes?:  string;
  createdAt:         string;
  resolvedAt?:       string;
}
```

- [x] **Step 2: Re-export**

In `src/types.ts`:

```typescript
export * from './types/export-bundle.js';
```

- [x] **Step 3: Typecheck**

Run: `pnpm run build`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/types/export-bundle.ts src/types.ts
git commit -m "feat(export): bundle types and conflict shape"
```

---

## Task 3: Atom codec

**Files:**
- Create: `src/export/atom-codec.ts`
- Test: `test/export-codec-atom.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/export-codec-atom.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeAtom, parseAtomMarkdown, atomFilename } from '../src/export/atom-codec.js';
import type { KnowledgeAtom } from '../src/types/atoms.js';

const A: KnowledgeAtom = {
  id: 'bf3a2b1f-4c2d-4a0e-9111-000000000001',
  project: 'tuberosa',
  claim: 'pgvector column dim must equal EMBEDDING_DIMENSIONS in config.',
  type: 'gotcha',
  evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
  trigger: { errors: ['vector dimension mismatch'], symbols: ['EMBEDDING_DIMENSIONS'] },
  verification: { command: 'pnpm run eval:retrieval' },
  pitfalls: ["Don't lower --fail-under-hit-rate to mask failures"],
  links: [{ toAtomId: '2a91-aaaa-bbbb-cccc-dddddddddddd', kind: 'refines', confidence: 0.85 }],
  tier: 'canonical',
  reuseCount: 4,
  lastReusedAt: '2026-05-12T00:00:00.000Z',
  status: 'active',
  audit: { producedBy: 'agent_session', createdAt: '2026-05-12T00:00:00.000Z', updatedAt: '2026-05-26T00:00:00.000Z' },
};

test('serializeAtom + parseAtomMarkdown: round-trip preserves all fields', () => {
  const { content } = serializeAtom(A, { revision: 3 });
  const parsed = parseAtomMarkdown(content);
  assert.equal(parsed.frontmatter.id, A.id);
  assert.equal(parsed.frontmatter.revision, 3);
  assert.equal(parsed.frontmatter.tier, A.tier);
  assert.deepEqual(parsed.frontmatter.trigger, A.trigger);
  assert.deepEqual(parsed.frontmatter.evidence, A.evidence);
  assert.equal(parsed.body.trim(), A.claim);
});

test('parseAtomMarkdown: body is the claim when frontmatter.claim is absent', () => {
  const md = `---\nid: x\nrevision: 1\nproject: p\ntype: fact\ntier: draft\nstatus: active\ntrigger: { errors: [\"e\"] }\nevidence: [{ kind: file, path: a.ts }]\naudit: { producedBy: agent_session, createdAt: \"2026-05-01T00:00:00Z\", updatedAt: \"2026-05-01T00:00:00Z\" }\n---\n\nThis is the claim sentence.\n`;
  const parsed = parseAtomMarkdown(md);
  assert.equal(parsed.body.trim(), 'This is the claim sentence.');
  assert.equal(parsed.frontmatter.claim, undefined);
});

test('parseAtomMarkdown: frontmatter.claim overrides body when both present', () => {
  const md = `---\nid: x\nrevision: 1\nproject: p\ntype: fact\ntier: draft\nstatus: active\ntrigger: { errors: [\"e\"] }\nevidence: [{ kind: file, path: a.ts }]\nclaim: "Explicit claim wins."\naudit: { producedBy: agent_session, createdAt: \"2026-05-01T00:00:00Z\", updatedAt: \"2026-05-01T00:00:00Z\" }\n---\n\nIgnored body.\n`;
  const parsed = parseAtomMarkdown(md);
  // Claim resolution lives in toAtomInput, not parse. Assert frontmatter contains it.
  assert.equal(parsed.frontmatter.claim, 'Explicit claim wins.');
});

test('atomFilename: stable slug-and-id pattern', () => {
  const f = atomFilename(A);
  assert.match(f, /^pgvector-column-dim-must-equal-embedding-dimensions-bf3a\.md$/);
});

test('parseAtomMarkdown: throws with file location on bad YAML', () => {
  const md = `---\nid: x\ntier: !!! bad yaml\n---\nbody`;
  assert.throws(() => parseAtomMarkdown(md, { filename: 'atoms/bad.md' }), /atoms\/bad\.md/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/export-codec-atom.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the codec**

Create `src/export/atom-codec.ts`:

```typescript
import yaml from 'js-yaml';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { AtomFrontmatter } from '../types/export-bundle.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedAtomMarkdown {
  frontmatter: AtomFrontmatter;
  body: string;
}

export function parseAtomMarkdown(content: string, options: { filename?: string } = {}): ParsedAtomMarkdown {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) {
    throw new Error(`Atom markdown missing frontmatter${options.filename ? ' in ' + options.filename : ''}`);
  }
  let frontmatter: AtomFrontmatter;
  try {
    frontmatter = yaml.load(m[1]) as AtomFrontmatter;
  } catch (error) {
    throw new Error(`Invalid frontmatter${options.filename ? ' in ' + options.filename : ''}: ${(error as Error).message}`);
  }
  if (!frontmatter || typeof frontmatter !== 'object' || !frontmatter.id) {
    throw new Error(`Atom frontmatter missing required 'id'${options.filename ? ' in ' + options.filename : ''}`);
  }
  return { frontmatter, body: m[2] ?? '' };
}

export function serializeAtom(atom: KnowledgeAtom, options: { revision: number }): { content: string; filename: string } {
  const frontmatter: AtomFrontmatter = {
    id:        atom.id,
    revision:  options.revision,
    project:   atom.project,
    type:      atom.type,
    tier:      atom.tier,
    status:    atom.status,
    trigger:   atom.trigger,
    evidence:  atom.evidence,
    verification: atom.verification,
    pitfalls:  atom.pitfalls,
    links:     atom.links,
    audit:     {
      producedBy: atom.audit.producedBy,
      producedAtSessionId: atom.audit.producedAtSessionId,
      createdAt: atom.audit.createdAt,
      updatedAt: atom.audit.updatedAt,
    },
  };
  const yamlBlock = yaml.dump(frontmatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  const content = `---\n${yamlBlock}---\n\n${atom.claim}\n`;
  return { content, filename: atomFilename(atom) };
}

const SLUG_STOP_WORDS = new Set(['the','a','an','of','to','in','on','is','was','and','or','for','with','at']);

export function atomFilename(atom: KnowledgeAtom): string {
  const slug = atom.claim
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !SLUG_STOP_WORDS.has(w))
    .slice(0, 8)
    .join('-')
    || 'atom';
  const shortId = atom.id.replace(/-/g, '').slice(0, 4);
  return `${slug}-${shortId}.md`;
}

export function toAtomInputFromParsed(parsed: ParsedAtomMarkdown): KnowledgeAtom {
  const fm = parsed.frontmatter;
  const claim = fm.claim ?? parsed.body.trim();
  return {
    id: fm.id,
    project: fm.project,
    claim,
    type: fm.type,
    evidence: fm.evidence,
    trigger: fm.trigger,
    verification: fm.verification,
    pitfalls: fm.pitfalls,
    links: fm.links,
    tier: fm.tier,
    reuseCount: 0,
    lastReusedAt: undefined,
    status: fm.status,
    audit: {
      producedBy: fm.audit.producedBy as KnowledgeAtom['audit']['producedBy'],
      producedAtSessionId: fm.audit.producedAtSessionId,
      createdAt: fm.audit.createdAt,
      updatedAt: fm.audit.updatedAt,
    },
  };
}
```

- [x] **Step 4: Run the test**

Run: `node --test --import tsx test/export-codec-atom.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/export/atom-codec.ts test/export-codec-atom.test.ts
git commit -m "feat(export): atom Markdown codec (YAML frontmatter + body)"
```

---

## Task 4: Knowledge + edges codecs

**Files:**
- Create: `src/export/knowledge-codec.ts`
- Create: `src/export/edges-codec.ts`
- Tests: `test/export-codec-knowledge.test.ts`, `test/export-codec-edges.test.ts`

- [x] **Step 1: Knowledge codec test**

Create `test/export-codec-knowledge.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeKnowledge, parseKnowledgeMarkdown, knowledgeFilename } from '../src/export/knowledge-codec.js';
import type { StoredKnowledge } from '../src/types.js';

const K: StoredKnowledge = {
  id: 'e5d4-0000-0000-0000-000000000001',
  project: 'tuberosa',
  sourceType: 'manual',
  sourceUri: 'docs/pgvector.md',
  itemType: 'wiki',
  title: 'Pgvector tuning notes',
  summary: 'Notes',
  content: '# Pgvector tuning notes\n\nLong-form content body.',
  labels: [{ type: 'domain', value: 'retrieval', weight: 1 }],
  references: [{ type: 'file', uri: 'src/retrieval/policy.ts' }],
  trustLevel: 70,
  status: 'approved',
  metadata: {},
  createdAt: '2026-04-12T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

test('serializeKnowledge round-trips title/labels/refs and uses content as body', () => {
  const { content } = serializeKnowledge(K);
  const parsed = parseKnowledgeMarkdown(content);
  assert.equal(parsed.frontmatter.title, K.title);
  assert.deepEqual(parsed.frontmatter.labels, K.labels);
  assert.deepEqual(parsed.frontmatter.references, K.references);
  assert.equal(parsed.body.trim(), K.content.trim());
});

test('knowledgeFilename: slug + short id', () => {
  assert.match(knowledgeFilename(K), /^pgvector-tuning-notes-e5d4\.md$/);
});
```

- [x] **Step 2: Edges codec test**

Create `test/export-codec-edges.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { serializeEdges, parseEdgesJsonl } from '../src/export/edges-codec.js';
import type { BundleEdge } from '../src/types.js';

const edges: BundleEdge[] = [
  { from: 'aaaa', to: 'bbbb', kind: 'refines',         confidence: 0.85, inferenceSource: 'semantic' },
  { from: 'cccc', to: 'dddd', kind: 'co_changes_with', confidence: 0.62, inferenceSource: 'co_change' },
];

test('serializeEdges sorts deterministically by (from, to, kind)', () => {
  const shuffled = [...edges].reverse();
  const out = serializeEdges(shuffled);
  const lines = out.trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].from, 'aaaa');
});

test('parseEdgesJsonl round-trips', () => {
  const out = serializeEdges(edges);
  const parsed = parseEdgesJsonl(out);
  assert.deepEqual(parsed, edges);
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `node --test --import tsx test/export-codec-knowledge.test.ts test/export-codec-edges.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 4: Implement `knowledge-codec.ts`**

Create `src/export/knowledge-codec.ts` (parallel to atom codec; reuse the YAML pattern). Filename: same slug-and-short-id rule, drop the leading `#` from titles before slugifying.

```typescript
import yaml from 'js-yaml';
import type { StoredKnowledge } from '../types.js';
import type { KnowledgeFrontmatter } from '../types/export-bundle.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedKnowledgeMarkdown {
  frontmatter: KnowledgeFrontmatter;
  body: string;
}

export function parseKnowledgeMarkdown(content: string, options: { filename?: string } = {}): ParsedKnowledgeMarkdown {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) throw new Error(`Knowledge markdown missing frontmatter${options.filename ? ' in ' + options.filename : ''}`);
  const frontmatter = yaml.load(m[1]) as KnowledgeFrontmatter;
  if (!frontmatter?.id) throw new Error(`Knowledge frontmatter missing 'id'${options.filename ? ' in ' + options.filename : ''}`);
  return { frontmatter, body: m[2] ?? '' };
}

export function serializeKnowledge(k: StoredKnowledge): { content: string; filename: string } {
  const fm: KnowledgeFrontmatter = {
    id:         k.id,
    project:    k.project,
    itemType:   k.itemType as KnowledgeFrontmatter['itemType'],
    title:      k.title,
    labels:     k.labels.map((l) => ({ type: l.type, value: l.value, weight: l.weight })),
    references: k.references,
    trustLevel: k.trustLevel ?? 50,
    audit:      { createdAt: k.createdAt, updatedAt: k.updatedAt },
  };
  const yamlBlock = yaml.dump(fm, { lineWidth: 120, noRefs: true, sortKeys: false });
  const content = `---\n${yamlBlock}---\n\n${k.content}\n`;
  return { content, filename: knowledgeFilename(k) };
}

const STOP = new Set(['the','a','an','of','to','in','on','is','was','and','or','for','with','at']);

export function knowledgeFilename(k: StoredKnowledge): string {
  const slug = (k.title || k.id).toLowerCase().replace(/^#+\s*/, '').split(/\W+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 8).join('-') || 'knowledge';
  const shortId = k.id.replace(/-/g, '').slice(0, 4);
  return `${slug}-${shortId}.md`;
}
```

- [x] **Step 5: Implement `edges-codec.ts`**

```typescript
import type { BundleEdge } from '../types/export-bundle.js';

export function serializeEdges(edges: BundleEdge[]): string {
  const sorted = [...edges].sort((a, b) =>
    a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || a.kind.localeCompare(b.kind));
  return sorted.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export function parseEdgesJsonl(content: string): BundleEdge[] {
  return content.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BundleEdge);
}
```

- [x] **Step 6: Run tests**

Run: `node --test --import tsx test/export-codec-knowledge.test.ts test/export-codec-edges.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/export/knowledge-codec.ts src/export/edges-codec.ts test/export-codec-knowledge.test.ts test/export-codec-edges.test.ts
git commit -m "feat(export): knowledge codec + sorted edges.jsonl codec"
```

---

## Task 5: Manifest + integrity helper

**Files:**
- Create: `src/export/manifest.ts`
- Test: covered by exporter/importer tests

- [x] **Step 1: Implement**

Create `src/export/manifest.ts`:

```typescript
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BundleManifest } from '../types/export-bundle.js';

export const SCHEMA_VERSION = 2;

export async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

export function sha256OfBuffer(buf: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

export async function writeManifest(path: string, manifest: BundleManifest): Promise<void> {
  // First write without the self-hash, hash the bytes, then write with the self-hash.
  const base = { ...manifest, integrity: { ...manifest.integrity, manifest_self: 'pending' } };
  const baseBytes = Buffer.from(JSON.stringify(base, null, 2), 'utf8');
  const selfHash = sha256OfBuffer(baseBytes);
  const final = { ...manifest, integrity: { ...manifest.integrity, manifest_self: selfHash } };
  await writeFile(path, JSON.stringify(final, null, 2), 'utf8');
}

export async function readManifest(path: string): Promise<BundleManifest> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as BundleManifest;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported pack schemaVersion ${parsed.schemaVersion} (this Tuberosa supports ${SCHEMA_VERSION})`);
  }
  return parsed;
}
```

- [x] **Step 2: Commit**

```bash
git add src/export/manifest.ts
git commit -m "feat(export): manifest read/write with self-hash integrity"
```

---

## Task 6: Exporter

**Files:**
- Create: `src/export/exporter.ts`
- Create: `src/export/readme-template.ts`
- Create: `scripts/export-pack.ts`
- Modify: `package.json`
- Test: `test/export-exporter.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/export-exporter.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';

async function seed(store: MemoryKnowledgeStore) {
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'gotcha', evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'Use HNSW for ANN search.',
    type: 'fact', evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.7,
    inferenceSource: 'semantic',
  }], { source: 'semantic' });
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'docs/pgvector.md',
    itemType: 'wiki', title: 'Pgvector tuning notes', summary: '',
    content: '# Pgvector tuning notes\n\nLong-form.', labels: [], references: [], metadata: {},
  }, []);
  return { a, b };
}

test('exportPack: writes manifest, atoms, knowledge, edges; counts match', async () => {
  const store = new MemoryKnowledgeStore();
  await seed(store);
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out });
  const dirs = await readdir(out);
  assert.ok(dirs.includes('manifest.json'));
  assert.ok(dirs.includes('atoms'));
  assert.ok(dirs.includes('knowledge'));
  assert.ok(dirs.includes('edges.jsonl'));
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.atoms, 2);
  assert.equal(manifest.counts.knowledge, 1);
  assert.equal(manifest.counts.edges, 1);
});

test('exportPack: archived atoms are excluded by default', async () => {
  const store = new MemoryKnowledgeStore();
  const { a } = await seed(store);
  await store.updateAtom(a.id, { status: 'archived' });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.atoms, 1);
});

test('exportPack: re-exporting same data is byte-identical except for generated timestamp', async () => {
  const store = new MemoryKnowledgeStore();
  await seed(store);
  const out1 = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out: out1 });
  const out2 = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out: out2 });
  const edges1 = await readFile(join(out1, 'edges.jsonl'), 'utf8');
  const edges2 = await readFile(join(out2, 'edges.jsonl'), 'utf8');
  assert.equal(edges1, edges2);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/export-exporter.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the exporter**

Create `src/export/readme-template.ts`:

```typescript
export const README_TEMPLATE = `# Tuberosa Project Pack

This directory is a portable export of a Tuberosa project. You can:

- **Read** atoms and knowledge by opening any \`.md\` file.
- **Edit** an atom: change the body or frontmatter fields, save. Bump the \`revision\` if you want.
- **Add** a new atom: drop a \`.md\` file in \`atoms/\` with valid frontmatter (copy any existing file as a template).
- **Append** a new edge: append a JSON line to \`edges.jsonl\` with the same shape as existing lines.

Import on the receiving side:

\`\`\`bash
pnpm run import-pack -- --from path/to/.tuberosa-pack
\`\`\`

Conflicts (same atom id, different content) go to the Tuberosa workbench "Import conflicts" tab for review. Edges auto-merge by max confidence.
`;
```

Create `src/export/exporter.ts`:

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { BundleManifest, BundleEdge } from '../types/export-bundle.js';
import { serializeAtom, atomFilename } from './atom-codec.js';
import { serializeKnowledge, knowledgeFilename } from './knowledge-codec.js';
import { serializeEdges } from './edges-codec.js';
import { sha256OfBuffer, writeManifest, SCHEMA_VERSION } from './manifest.js';
import { README_TEMPLATE } from './readme-template.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';

export interface ExportOptions {
  project: string;
  out: string;
  includeChunks?: boolean;
  includeArchived?: boolean;
  maxChunkTokens?: number;
  sourceCommit?: string;
  dryRun?: boolean;
  prune?: boolean;
}

export interface ExportReport {
  atoms: number;
  knowledge: number;
  edges: number;
  chunks: number;
  outPath: string;
}

export async function exportPack(store: KnowledgeStore, opts: ExportOptions): Promise<ExportReport> {
  const safety = new KnowledgeSafetyService();
  await mkdir(opts.out, { recursive: true });
  await mkdir(join(opts.out, 'atoms'), { recursive: true });
  await mkdir(join(opts.out, 'knowledge'), { recursive: true });

  // Atoms
  const atomCriteria = { project: opts.project, status: 'active' as const, limit: 10000 };
  const atoms = (await store.listAtoms(atomCriteria))
    .filter((a) => opts.includeArchived || a.status === 'active');
  for (const atom of atoms) {
    const safe: KnowledgeAtom = { ...atom, claim: safety.redactSecrets(atom.claim) };
    const { content, filename } = serializeAtom(safe, { revision: atom.reuseCount + 1 });
    if (!opts.dryRun) await writeFile(join(opts.out, 'atoms', filename), content, 'utf8');
  }

  // Knowledge (non-memory types)
  const allKnowledge = await store.listKnowledge({ project: opts.project, limit: 10000 });
  const knowledge = allKnowledge.filter((k) =>
    !['memory', 'bugfix', 'rule'].includes(k.itemType)
    && (k.status === 'approved' || k.status === undefined)
    && !((k.metadata as { legacyStatus?: string } | undefined)?.legacyStatus),
  );
  for (const item of knowledge) {
    const safe = { ...item, content: safety.redactSecrets(item.content) };
    const { content, filename } = serializeKnowledge(safe);
    if (!opts.dryRun) await writeFile(join(opts.out, 'knowledge', filename), content, 'utf8');
  }

  // Edges
  const allRelations = await store.listAtomRelations({ limit: 100000 });
  const atomIds = new Set(atoms.map((a) => a.id));
  const bundleEdges: BundleEdge[] = allRelations
    .filter((r) => atomIds.has(r.fromAtomId) && atomIds.has(r.targetAtomId))
    .map((r) => ({
      from: r.fromAtomId, to: r.targetAtomId,
      kind: r.relationType, confidence: r.confidence, inferenceSource: r.inferenceSource,
    }));
  const edgesContent = serializeEdges(bundleEdges);
  if (!opts.dryRun) await writeFile(join(opts.out, 'edges.jsonl'), edgesContent, 'utf8');

  // Chunks
  let chunks = 0;
  if (opts.includeChunks !== false) {
    const tierFor = new Map(atoms.map((a) => [a.id, a.tier] as const));
    const includedAtomIds = atoms.filter((a) => tierFor.get(a.id) !== 'draft').map((a) => a.id);
    const knowledgeIds = knowledge.map((k) => k.id);
    const chunkRecords = await store.listKnowledgeChunks([...includedAtomIds, ...knowledgeIds]);
    const budget = opts.maxChunkTokens ?? 200000;
    let used = 0;
    await mkdir(join(opts.out, 'chunks'), { recursive: true });
    for (const chunk of chunkRecords) {
      if (used + chunk.tokenEstimate > budget) break;
      await mkdir(join(opts.out, 'chunks', chunk.knowledgeId), { recursive: true });
      const safeContent = safety.redactSecrets(chunk.content);
      if (!opts.dryRun) await writeFile(join(opts.out, 'chunks', chunk.knowledgeId, `${chunk.chunkIndex}.txt`), safeContent, 'utf8');
      used += chunk.tokenEstimate;
      chunks += 1;
    }
  }

  if (!opts.dryRun) {
    await writeFile(join(opts.out, 'README.md'), README_TEMPLATE, 'utf8');
  }

  const edgesHash = sha256OfBuffer(edgesContent);
  const manifest: BundleManifest = {
    schemaVersion: SCHEMA_VERSION,
    project: opts.project,
    generated: new Date().toISOString(),
    sourceCommit: opts.sourceCommit,
    counts: { atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks },
    integrity: { 'edges.jsonl': edgesHash },
    tierPolicy: {
      exportedTiers: ['draft', 'verified', 'canonical'],
      excludedStatuses: opts.includeArchived ? [] : ['archived', 'legacy_archived', 'superseded'],
    },
    includesChunks: opts.includeChunks !== false,
    safetyRedactionVersion: '1',
  };
  if (!opts.dryRun) await writeManifest(join(opts.out, 'manifest.json'), manifest);

  return { atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks, outPath: opts.out };
}
```

- [x] **Step 4: Add CLI**

Create `scripts/export-pack.ts`:

```typescript
import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { exportPack } from '../src/export/exporter.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    out: { type: 'string', default: '.tuberosa-pack' },
    'include-chunks': { type: 'boolean', default: true },
    'include-archived': { type: 'boolean', default: false },
    'max-chunk-tokens': { type: 'string', default: '200000' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.project) {
  console.error('--project is required');
  process.exit(2);
}

const services = await createAppServices();
const report = await exportPack(services.store, {
  project: values.project,
  out: values.out!,
  includeChunks: Boolean(values['include-chunks']),
  includeArchived: Boolean(values['include-archived']),
  maxChunkTokens: Number(values['max-chunk-tokens']),
  dryRun: Boolean(values['dry-run']),
});
console.log(JSON.stringify(report, null, 2));
await services.close();
```

Add npm script:

```json
    "export-pack": "node --import tsx scripts/export-pack.ts"
```

- [x] **Step 5: Run the tests**

Run: `node --test --import tsx test/export-exporter.test.ts`
Expected: PASS.

- [x] **Step 6: Smoke-test the CLI**

Run: `pnpm run export-pack -- --project tuberosa --out /tmp/tpack`
Expected: exits 0; `/tmp/tpack/manifest.json` exists.

- [x] **Step 7: Commit**

```bash
git add src/export/exporter.ts src/export/readme-template.ts scripts/export-pack.ts package.json test/export-exporter.test.ts
git commit -m "feat(export): exporter + CLI with chunk budget and archived filter"
```

---

## Task 7: Conflict store methods

**Files:**
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Create: `src/operations/atom-import-conflicts.ts`
- Test: covered by importer tests

- [x] **Step 1: Add interface methods**

```typescript
// in KnowledgeStore:
  createAtomImportConflict(input: {
    project: string;
    atomId: string;
    localSnapshot: unknown;
    importedSnapshot: unknown;
    bundleSource: string;
  }): Promise<AtomImportConflict>;
  listAtomImportConflicts(options: { project?: string; status?: 'open' | string; limit: number }): Promise<AtomImportConflict[]>;
  getAtomImportConflict(id: string): Promise<AtomImportConflict | undefined>;
  resolveAtomImportConflict(id: string, action: 'keep_local' | 'take_imported' | 'merged' | 'dismissed', mergedSnapshot?: unknown, notes?: string): Promise<AtomImportConflict | undefined>;
```

- [x] **Step 2: Implement on memory store**

```typescript
  private readonly atomImportConflicts = new Map<string, AtomImportConflict>();

  async createAtomImportConflict(input: { project: string; atomId: string; localSnapshot: unknown; importedSnapshot: unknown; bundleSource: string }): Promise<AtomImportConflict> {
    const row: AtomImportConflict = {
      id: randomUUID(),
      project: input.project,
      atomId: input.atomId,
      localSnapshot: input.localSnapshot as KnowledgeAtom,
      importedSnapshot: input.importedSnapshot as AtomImportConflict['importedSnapshot'],
      bundleSource: input.bundleSource,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.atomImportConflicts.set(row.id, row);
    return row;
  }

  async listAtomImportConflicts(options: { project?: string; status?: string; limit: number }): Promise<AtomImportConflict[]> {
    return [...this.atomImportConflicts.values()]
      .filter((c) => !options.project || c.project === options.project)
      .filter((c) => !options.status   || c.status === options.status)
      .slice(0, options.limit);
  }

  async getAtomImportConflict(id: string): Promise<AtomImportConflict | undefined> {
    return this.atomImportConflicts.get(id);
  }

  async resolveAtomImportConflict(id: string, action: 'keep_local' | 'take_imported' | 'merged' | 'dismissed', mergedSnapshot?: unknown, notes?: string): Promise<AtomImportConflict | undefined> {
    const row = this.atomImportConflicts.get(id);
    if (!row) return undefined;
    const status: AtomImportConflict['status'] =
      action === 'keep_local'     ? 'resolved_keep_local'    :
      action === 'take_imported'  ? 'resolved_take_imported' :
      action === 'merged'         ? 'resolved_merged'        :
                                    'dismissed';
    const next: AtomImportConflict = { ...row, status, resolutionNotes: notes, resolvedAt: new Date().toISOString() };
    this.atomImportConflicts.set(id, next);
    // Apply resolution to the actual atom
    if (action === 'take_imported' && next.importedSnapshot) {
      const imp = next.importedSnapshot as AtomImportConflict['importedSnapshot'];
      await this.updateAtom(next.atomId, {
        tier: imp.tier as 'draft', status: imp.status as 'active',
      } as never);
    } else if (action === 'merged' && mergedSnapshot) {
      const m = mergedSnapshot as Partial<KnowledgeAtom>;
      await this.updateAtom(next.atomId, m as never);
    }
    return next;
  }
```

- [x] **Step 3: Implement on postgres store**

Parallel to memory: INSERT into `atom_import_conflicts`, SELECT by filters, UPDATE for resolve. Apply atom mutation in the same transaction when `take_imported` or `merged`.

- [x] **Step 4: Implement `atom-import-conflicts.ts` service wrapper**

```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { AtomImportConflict } from '../types/export-bundle.js';

export async function listConflicts(store: KnowledgeStore, options: { project?: string; status?: string; limit?: number }): Promise<AtomImportConflict[]> {
  return store.listAtomImportConflicts({ project: options.project, status: options.status, limit: options.limit ?? 50 });
}

export async function resolveConflict(
  store: KnowledgeStore,
  id: string,
  action: 'keep_local' | 'take_imported' | 'merged' | 'dismissed',
  mergedSnapshot?: unknown,
  notes?: string,
): Promise<AtomImportConflict | undefined> {
  return store.resolveAtomImportConflict(id, action, mergedSnapshot, notes);
}
```

- [x] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts src/operations/atom-import-conflicts.ts
git commit -m "feat(export): atom_import_conflicts store methods + service"
```

---

## Task 8: Importer

**Files:**
- Create: `src/export/importer.ts`
- Create: `scripts/import-pack.ts`
- Modify: `package.json`
- Test: `test/export-importer.test.ts`, `test/export-importer-conflicts.test.ts`

- [x] **Step 1: Write the failing happy-path test**

Create `test/export-importer.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';
import { importPack } from '../src/export/importer.js';

test('importPack: round-trips export → import on a fresh store with no conflicts', async () => {
  const source = new MemoryKnowledgeStore();
  await source.createAtom({
    project: 'tuberosa', claim: 'Use HNSW for ANN search.',
    type: 'fact', evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] }, producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });

  const dest = new MemoryKnowledgeStore();
  const report = await importPack(dest, { from: out });
  assert.equal(report.atomsInserted, 1);
  assert.equal(report.conflictsQueued, 0);
  const atoms = await dest.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].tier, 'draft', 'imported atoms always start at draft locally');
});
```

- [x] **Step 2: Write the failing conflict test**

Create `test/export-importer-conflicts.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';
import { importPack } from '../src/export/importer.js';

test('importPack: differing local atom queues a conflict; local stays unchanged', async () => {
  // 1. Export from source.
  const source = new MemoryKnowledgeStore();
  const a = await source.createAtom({
    project: 'tuberosa', claim: 'Use HNSW for ANN search.',
    type: 'fact', evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] }, producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });

  // 2. Edit the exported atom file.
  const atomsDir = join(out, 'atoms');
  const file = (await readdir(atomsDir))[0];
  const content = await readFile(join(atomsDir, file), 'utf8');
  await writeFile(join(atomsDir, file), content.replace('Use HNSW', 'Use IVFFlat'), 'utf8');

  // 3. Receiver already has the same atom by id.
  const dest = new MemoryKnowledgeStore();
  // Force same id on receiver by inserting then renaming; for the test, we mutate via reflection on the memory map.
  // Simplest: insert with our own id by going through the lower-level create path.
  // (Memory store assigns randomUUID inside createAtom. For the test, we copy the imported file id into dest.)
  const imported = JSON.parse(JSON.stringify(a));
  await dest.createAtom({
    project: imported.project, claim: imported.claim,
    type: imported.type, evidence: imported.evidence,
    trigger: imported.trigger, producedBy: 'agent_session',
  });
  // Receiver atom has its own id — for the conflict test we want SAME id.
  // Cleaner alternative: assert that an atom with the SAME claim text but different evidence
  // surfaces as a conflict via the matchByClaimAndType fallback. The importer should support both.

  const report = await importPack(dest, { from: out });
  assert.ok(report.conflictsQueued >= 1, JSON.stringify(report));
  const conflicts = await dest.listAtomImportConflicts({ project: 'tuberosa', status: 'open', limit: 10 });
  assert.equal(conflicts.length, 1);
});
```

(The id-match path is straightforward; the dual-key match-by-claim-and-type fallback is documented inline in the importer below.)

- [x] **Step 3: Run the tests to verify they fail**

Run: `node --test --import tsx test/export-importer.test.ts test/export-importer-conflicts.test.ts`
Expected: FAIL — `importPack` does not exist.

- [x] **Step 4: Implement the importer**

Create `src/export/importer.ts`:

```typescript
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import { parseAtomMarkdown, toAtomInputFromParsed } from './atom-codec.js';
import { parseKnowledgeMarkdown } from './knowledge-codec.js';
import { parseEdgesJsonl } from './edges-codec.js';
import { readManifest, sha256OfBuffer } from './manifest.js';

export interface ImportOptions {
  from: string;
  project?: string;
  dryRun?: boolean;
  onConflict?: 'review' | 'skip';
}

export interface ImportReport {
  atomsInserted: number;
  atomsUnchanged: number;
  conflictsQueued: number;
  knowledgeInserted: number;
  knowledgeUnchanged: number;
  edgesInserted: number;
  edgesUpdated: number;
  bundleSource: string;
}

export async function importPack(store: KnowledgeStore, opts: ImportOptions): Promise<ImportReport> {
  const manifest = await readManifest(join(opts.from, 'manifest.json'));
  const project = opts.project ?? manifest.project;
  const report: ImportReport = {
    atomsInserted: 0, atomsUnchanged: 0, conflictsQueued: 0,
    knowledgeInserted: 0, knowledgeUnchanged: 0,
    edgesInserted: 0, edgesUpdated: 0,
    bundleSource: opts.from,
  };
  const onConflict = opts.onConflict ?? 'review';

  // Verify edges integrity (best-effort warning)
  const edgesContent = await readFile(join(opts.from, 'edges.jsonl'), 'utf8');
  const expectedHash = manifest.integrity['edges.jsonl'];
  const actualHash = sha256OfBuffer(edgesContent);
  if (expectedHash && expectedHash !== actualHash) {
    process.stderr.write(`[import-pack] edges.jsonl hash mismatch: expected ${expectedHash}, got ${actualHash}\n`);
  }

  // Atoms
  const atomFiles = (await readdir(join(opts.from, 'atoms'))).filter((f) => f.endsWith('.md'));
  for (const file of atomFiles) {
    const raw = await readFile(join(opts.from, 'atoms', file), 'utf8');
    const parsed = parseAtomMarkdown(raw, { filename: `atoms/${file}` });
    const incoming = toAtomInputFromParsed(parsed);
    incoming.project = project;
    const existing = await store.getAtom(incoming.id);
    if (!existing) {
      if (!opts.dryRun) {
        await store.createAtom({
          project: incoming.project,
          claim: incoming.claim,
          type: incoming.type,
          evidence: incoming.evidence,
          trigger: incoming.trigger,
          verification: incoming.verification,
          pitfalls: incoming.pitfalls,
          links: incoming.links,
          producedBy: 'user',
        });
        // Force tier=draft and preserve source tier hint
        const created = await store.getAtom(incoming.id);
        if (created) {
          await store.updateAtom(created.id, { tier: 'draft' } as never);
        }
      }
      report.atomsInserted += 1;
      continue;
    }
    if (atomsEquivalent(existing, incoming)) {
      report.atomsUnchanged += 1;
      continue;
    }
    if (onConflict === 'skip') {
      continue;
    }
    if (!opts.dryRun) {
      await store.createAtomImportConflict({
        project,
        atomId: existing.id,
        localSnapshot: existing,
        importedSnapshot: { ...parsed.frontmatter, body: parsed.body },
        bundleSource: opts.from,
      });
    }
    report.conflictsQueued += 1;
  }

  // Knowledge (similar pattern; on conflict we currently log and skip — knowledge has its own update API)
  const kFiles = (await readdir(join(opts.from, 'knowledge'))).filter((f) => f.endsWith('.md'));
  for (const file of kFiles) {
    const raw = await readFile(join(opts.from, 'knowledge', file), 'utf8');
    const parsed = parseKnowledgeMarkdown(raw, { filename: `knowledge/${file}` });
    const existing = await store.getKnowledge(parsed.frontmatter.id);
    if (!existing) {
      if (!opts.dryRun) {
        await store.upsertKnowledge({
          project,
          sourceType: 'imported',
          sourceUri: `bundle://${opts.from}/${file}`,
          itemType: parsed.frontmatter.itemType,
          title: parsed.frontmatter.title,
          summary: '',
          content: parsed.body,
          labels: parsed.frontmatter.labels,
          references: parsed.frontmatter.references,
          trustLevel: parsed.frontmatter.trustLevel,
          metadata: { importedFrom: opts.from },
        }, []);
      }
      report.knowledgeInserted += 1;
    } else {
      report.knowledgeUnchanged += 1;
    }
  }

  // Edges
  const edges = parseEdgesJsonl(edgesContent);
  for (const edge of edges) {
    const existing = await store.listAtomRelations({
      fromAtomId: edge.from, targetAtomId: edge.to, limit: 5,
    });
    const same = existing.find((r) => r.relationType === edge.kind && r.inferenceSource === edge.inferenceSource);
    if (!same) {
      if (!opts.dryRun) {
        await store.replaceAtomRelations(edge.from, [{
          fromAtomId: edge.from, targetAtomId: edge.to, relationType: edge.kind,
          confidence: edge.confidence, inferenceSource: edge.inferenceSource,
        }], { source: edge.inferenceSource });
      }
      report.edgesInserted += 1;
    } else if (edge.confidence > same.confidence) {
      if (!opts.dryRun) {
        await store.replaceAtomRelations(edge.from, [{
          fromAtomId: edge.from, targetAtomId: edge.to, relationType: edge.kind,
          confidence: edge.confidence, inferenceSource: edge.inferenceSource,
        }], { source: edge.inferenceSource });
      }
      report.edgesUpdated += 1;
    }
  }

  return report;
}

function atomsEquivalent(a: KnowledgeAtom, b: KnowledgeAtom): boolean {
  return a.claim === b.claim
    && a.type === b.type
    && JSON.stringify(a.evidence) === JSON.stringify(b.evidence)
    && JSON.stringify(a.trigger) === JSON.stringify(b.trigger);
}
```

- [x] **Step 5: Add CLI**

Create `scripts/import-pack.ts`:

```typescript
import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { importPack } from '../src/export/importer.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'on-conflict': { type: 'string', default: 'review' },
  },
});

if (!values.from) {
  console.error('--from is required');
  process.exit(2);
}

const services = await createAppServices();
const report = await importPack(services.store, {
  from: values.from,
  project: values.project,
  dryRun: Boolean(values['dry-run']),
  onConflict: values['on-conflict'] === 'skip' ? 'skip' : 'review',
});
console.log(JSON.stringify(report, null, 2));
await services.close();
```

Add npm script:

```json
    "import-pack": "node --import tsx scripts/import-pack.ts"
```

- [x] **Step 6: Run the tests**

Run: `node --test --import tsx test/export-importer.test.ts test/export-importer-conflicts.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/export/importer.ts scripts/import-pack.ts package.json test/export-importer.test.ts test/export-importer-conflicts.test.ts
git commit -m "feat(export): importer with conflict detection + dry-run + skip mode"
```

---

## Task 9: HTTP + MCP surfaces

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/mcp/server.ts`

- [x] **Step 1: HTTP routes**

```typescript
  app.post('/operations/import-pack', requireAuth, async (req, res) => {
    const { from, project, dryRun, onConflict } = req.body ?? {};
    if (typeof from !== 'string') return res.status(400).json({ error: 'from required' });
    res.json(await importPack(store, {
      from, project, dryRun: Boolean(dryRun),
      onConflict: onConflict === 'skip' ? 'skip' : 'review',
    }));
  });

  app.get('/operations/atom-import-conflicts', requireAuth, async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    res.json(await store.listAtomImportConflicts({ project, status, limit: 100 }));
  });

  app.get('/operations/atom-import-conflicts/:id', requireAuth, async (req, res) => {
    const row = await store.getAtomImportConflict(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  app.post('/operations/atom-import-conflicts/:id/resolve', requireAuth, async (req, res) => {
    const { action, mergedSnapshot, notes } = req.body ?? {};
    const updated = await store.resolveAtomImportConflict(req.params.id, action, mergedSnapshot, notes);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });
```

- [x] **Step 2: MCP tools**

```typescript
  server.registerTool('tuberosa_export_pack', {
    description: 'Write a portable .tuberosa-pack/ directory for the given project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        out: { type: 'string' },
        includeChunks: { type: 'boolean', default: true },
        includeArchived: { type: 'boolean', default: false },
      },
      required: ['project', 'out'],
    },
  }, async ({ project, out, includeChunks, includeArchived }) => {
    const report = await exportPack(store, { project, out, includeChunks, includeArchived });
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });

  server.registerTool('tuberosa_import_pack', {
    description: 'Import a .tuberosa-pack/ directory. Atom conflicts queue for human review by default.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        project: { type: 'string' },
        dryRun: { type: 'boolean', default: false },
        onConflict: { type: 'string', enum: ['review', 'skip'], default: 'review' },
      },
      required: ['from'],
    },
  }, async ({ from, project, dryRun, onConflict }) => {
    const report = await importPack(store, { from, project, dryRun, onConflict });
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });

  server.registerTool('tuberosa_list_atom_import_conflicts', {
    description: 'List atom import conflicts (default status=open).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' } } },
  }, async ({ project, status }) => {
    const rows = await store.listAtomImportConflicts({ project, status: status ?? 'open', limit: 100 });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  });

  server.registerTool('tuberosa_resolve_atom_import_conflict', {
    description: 'Resolve an atom import conflict (keep_local | take_imported | merged | dismissed).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['keep_local', 'take_imported', 'merged', 'dismissed'] },
        mergedSnapshot: { type: 'object' },
        notes: { type: 'string' },
      },
      required: ['id', 'action'],
    },
  }, async ({ id, action, mergedSnapshot, notes }) => {
    const updated = await store.resolveAtomImportConflict(id, action, mergedSnapshot, notes);
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
  });
```

- [x] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/http/server.ts src/mcp/server.ts
git commit -m "feat(export): HTTP + MCP routes for export/import + conflict resolution"
```

---

## Task 10: Eval fixture for round-trip retrieval

**Files:**
- Modify: `eval/retrieval-fixtures.json`

- [x] **Step 1: Add fixture**

```jsonc
{
  "name": "export/import round-trip preserves retrieval results",
  "roundTrip": {
    "project": "tuberosa",
    "atoms": [
      { "claim": "Use HNSW for ANN search.", "type": "fact",
        "evidence": [{"kind":"file","path":"m.sql"}], "trigger": {"symbols":["hnsw"]} }
    ],
    "edges": [],
    "query": { "prompt": "ANN search", "symbols": ["hnsw"] }
  },
  "expect": { "topClaimsContain": ["Use HNSW for ANN search."] }
}
```

Extend the runner: when `roundTrip` is present, ingest into source store, export to a temp dir, create a fresh store, import, then run the query against the fresh store.

- [x] **Step 2: Run the eval**

Run: `pnpm run eval:retrieval`
Expected: PASS including the round-trip case.

- [x] **Step 3: Commit**

```bash
git add eval/retrieval-fixtures.json eval/retrieval.ts
git commit -m "test(export): round-trip fixture asserts retrieval after export+import"
```

---

## Task 11: Final verification

- [x] **Step 1: Full unit suite**

Run: `pnpm test`
Expected: PASS.

- [x] **Step 2: Retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [x] **Step 3: Integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [x] **Step 4: End-to-end smoke**

```bash
pnpm run export-pack -- --project tuberosa --out /tmp/tpack
ls -la /tmp/tpack
cat /tmp/tpack/manifest.json | jq .counts
pnpm run import-pack -- --from /tmp/tpack --dry-run
```
Expected: export emits a populated bundle; import dry-run reports `unchanged` counts equal to export counts.

- [x] **Step 5: Commit any final touch-ups**

```bash
git add -A
git commit -m "test(export): green eval suite after concern E"
```

---

## Follow-up (deferred)

- **Bundle search/preview before import.** A CLI flag `--preview` that lists atoms/edges without ingesting. Useful for vetting third-party bundles.
- **Gzip the bundle** for transport. `tuberosa pack --gzip` produces `.tuberosa-pack.tar.gz`; importer auto-extracts.
- **Cryptographic signing** of `manifest.json` so receivers can verify a bundle came from a trusted source.
- **Bidirectional sync** for two teammates exporting / merging across time. v1 is one-way per call; iterative sync is future work.
- **Workbench "Import conflicts" tab UI.** Backend ships here; UI is a separate task.
- **`tuberosa preview-pack <path>` MCP tool** that lists pack contents and diffs vs the local project without ingesting.
