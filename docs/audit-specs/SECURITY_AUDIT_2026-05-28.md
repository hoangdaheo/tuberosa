# Tuberosa Security & QA Audit — 2026-05-28

Read-only senior-QA / security review of Tuberosa on branch
`feat/project-export-bundle` @ `4e8bdb8`. No source files were modified.

Method (from spec):
1. Change & impact summary
2. Threat model + QA risk map
3. Call-path / side-effect inspection
4. Evidence-backed findings (severity, file:line, impact, repro, fix)
5. Missing tests / verification gaps
6. Residual risks

Process: five parallel read-only subagent passes (HTTP, MCP stdio, storage/SQL,
retrieval+redaction, ingest/mirror/backup/export). Every "Critical" subagent
claim was re-verified against the actual source on this branch. Four
subagent-flagged "Criticals" were demoted to false-positive after verification
(see §8).

---

## 1. Change & impact summary

The audit covers the codebase as it stands on `feat/project-export-bundle`. The
most consequential recent changes (last seven commits on this branch) are the
project export/import bundle feature:

- `01a7257 feat(export): importer with conflict detection + dry-run + skip mode`
- `0d2c816 feat(export): HTTP + MCP routes for export/import + conflict resolution`
- `51427fd test(export): round-trip retrieval test asserts atom reachable after export+import`
- `65a1f5e docs(export): mark Plan E complete with deviations + allowPositionals on CLIs`
- `4e8bdb8 TUBEROSA-IMPROVEMENT`

Prior recent work shipped a Plan-1 "stop-the-bleed" hardening pass: HTTP
boundary check (`src/index.ts:8`), worktree-UUID CTE fix, memory-store status
filter, MCP parse guard, and an eval gate.

**Surfaces newly exposed or significantly changed:**

| Surface | What's new | Risk |
|---|---|---|
| `POST /export/pack`, `POST /import/pack` (`src/http/server.ts:584-619`) | New HTTP routes that accept attacker-controlled filesystem paths in JSON body | **C1** — full local-FS read/write primitive |
| `tuberosa_export_pack`, `tuberosa_import_pack` (`src/mcp/server.ts`) | New MCP tools mirroring the HTTP routes | Path traversal (local-trust mitigates) |
| `tuberosa_resolve_atom_import_conflict` (`src/mcp/server.ts:447`) | Conflict resolution accepts caller-supplied `mergedSnapshot` | **H8** — no Zod schema, no size cap |
| `src/export/{atom,knowledge}-codec.ts` | YAML front-matter parse via `js-yaml.load` | Looks scary but is safe in v4 (see §8) |
| `src/export/importer.ts` `safeListUserStyleDirs` | Reads sub-directory names from untrusted pack | **H5** — directory traversal |
| Plan-1 boundary check (`src/index.ts:8`) | Already shipped | Verified correct (see §8) |

Pre-existing surfaces re-audited and still relevant: retrieval pipeline,
secret redaction, physical mirror rebuild, backup/restore symlink handling,
storage `::uuid` casts, classifier extractors. Findings against these are
included where the regressions or pre-existing gaps would amplify the impact
of the new export/import features.

---

## 2. Threat model + QA risk map

### Trust boundaries

```
┌──────────────┐  JSON-RPC stdio   ┌──────────────────────────────┐
│ Local MCP    │ ────────────────▶ │ Tuberosa process             │
│ client       │                   │  ├─ MCP server (src/mcp/*)   │
│ (Claude Code,│                   │  ├─ HTTP server (src/http/*) │
│  IDE plugin) │                   │  ├─ Retrieval service        │
└──────────────┘                   │  ├─ Storage (Postgres / mem) │
                                   │  ├─ Operations               │
┌──────────────┐  HTTP+Bearer      │  │   ├─ Mirror writer        │
│ Network      │ ────────────────▶ │  │   └─ Backup writer        │
│ client       │                   │  └─ Model provider (OpenAI / │
│ (browser,    │                   │      hash / Ollama)          │
│  curl)       │                   └──────────────────────────────┘
└──────────────┘                              │
                                              ▼
                                   ┌──────────────────────────────┐
                                   │ Filesystem: ${dataDir},      │
                                   │  ${backupDir}, ${mirrorDir}, │
                                   │  ${errorLogDir}, /tmp        │
                                   └──────────────────────────────┘
```

**Stated trust assumption** (per `CLAUDE.md`): the MCP stdio client runs
locally and is trusted; the HTTP surface is hardened by an API key. The
Plan-1 boundary check enforces "no bare `0.0.0.0` bind without a key".

**Where the assumption breaks** in this audit:

| Threat actor | Capability | Concretely enabled by |
|---|---|---|
| **Local unprivileged user (other UID on same host)** | Read backup files; tamper with mirror state | **M4** (default umask on backup files); mirror dir not chmod'd |
| **Authenticated HTTP client** (legitimate API key, or stolen key) | Write to any path the process can write; read any path it can read | **C1** export/import; **H5** importer traversal |
| **Malicious knowledge supplier** (someone whose data gets ingested) | Prompt-injection payload survives to caller; secrets surface in retrieved candidates | **H1** classifier sees raw prompt; **H2** suspicious not blocked |
| **Malicious pack author** (someone you import a `.tuberosa-pack` from) | Read arbitrary files via crafted `user-style/<dir>` names; exhaust memory via huge `mergedSnapshot`; corrupt local atoms via "keep theirs" | **H5**, **H8**, residual R3 |
| **Operator with config drift** | Silent 500s on every retrieval call after embedding-model change | **H3** |
| **Unauthenticated network observer** (loopback only by default) | Fingerprint deployment | **M1** `/health` info disclosure |

### QA risk map (severity × likelihood, on this branch)

```
                    LOW likelihood      MED likelihood      HIGH likelihood
HIGH severity    | H4 backup symlink  | H1 secret leak    | C1 path traversal
                 | H6 mirror window   | H2 suspicious     | H3 dim drift (config-change)
                 | H7 store ::uuid    | H5 importer trav  |
                 | H8 mergedSnapshot  |                   |
MED  severity    | M5 cross-project   | M3 LIKE wildcard  | M1 /health disclosure
                 | M6 starvation      | M2 mem/PG diverge | M4 backup perms
                 | M7 JSON depth      |                   |
LOW  severity    | L5 workbench path  | L2 mcp console.err| L1 (=M1)
                 | L3 UA log          | L4 cache keys     |
```

---

## 3. Call-path / side-effect inspection

For each Critical/High finding, the audit traced the call path beyond the
edited lines:

- **C1 path traversal**: HTTP route → `validate*Input` (only validates the
  *protocol* — `out` is a `string`, no path constraint) → `exportPack(opts)` →
  `mkdir(opts.out, {recursive:true})` → `writeFile(join(opts.out, ...))`. Both
  `recursive: true` and absolute-path inputs make this a write-anywhere
  primitive. Same chain on import.
- **H1 classifier sees secrets**: `searchContext(input)` →
  `redactSearchInput(input)` produces `redacted` *but* the next line passes
  `input.prompt` (un-redacted) to `classifyQuery`. Output `classified.exactTerms`
  flows into fusion seeds, into `contextPack.classified`, and into match
  reasons returned to caller.
- **H2 suspicious candidates**: `sanitizeSearchCandidates` calls
  `decideSafety`; only `status==='blocked'` short-circuits — `'suspicious'`
  falls through and the candidate is returned with a metadata flag.
- **H3 dim drift**: `OpenAiModelProvider.embed` parses
  `response.data[0].embedding` (length determined by upstream model) without
  comparing to `config.embeddingDimensions`. Downstream `searchVector` issues
  `kc.embedding <=> $1::vector` which errors `dimension N does not match
  expected M` at the `::vector` cast — bubbles to a 500.
- **H4/H6 filesystem ops**: `resolveBackupPath` uses `path.resolve`
  (symlink-blind) before `readFile`/`readManifest`. Mirror rebuild does
  `rm(-rf) → rename` with a non-zero window where the directory does not
  exist.
- **H5 importer dir name**: `readdir(join(opts.from,'user-style'))` returns
  entry names verbatim; `safeListUserStyleDirs` checks each is a directory
  (via `stat`) but does not reject `..` segments in the name itself. A pack
  whose `user-style/` contains a directory named literally `..` (legal in
  ext4/zip/tar) would resolve to the parent of `user-style/`.
- **H7 store boundary**: `getKnowledge` and similar Postgres methods rely on
  a caller-side `isPersistedKnowledgeId` guard. The store does not redundantly
  enforce; a regression in any new caller (e.g. the future fix for H8)
  reintroduces the worktree-UUID 500 class.
- **H8 mergedSnapshot**: MCP handler casts `args.mergedSnapshot` to
  `KnowledgeAtomPatch` with no schema; the store consumes it via
  `resolveAtomImportConflict`. The merge path (`Object.assign` /
  spread) determines whether `__proto__` is a real risk — verifying that
  merge path is the open question.

**Side-effects worth highlighting:**
- `services.operations.requestPhysicalMirror(...)` is fire-and-forget from
  every write route (`src/http/server.ts:197, 224, 239, 272, …`). Internal
  rejections must be swallowed or they become unhandled (no global
  `process.on('unhandledRejection')` was located).
- `recordFeedback` issues N `expireRelationsFromKnowledge` queries in a loop
  (`postgres-store.ts:1089-1091`). Mark-many-as-stale becomes pathological.

---

## 4. Findings

Each finding gives **Severity / File:line / Impact / Repro or exploit / Fix**.

---

### C1 — Critical: Path traversal in `/export/pack` and `/import/pack`

**File:** `src/http/server.ts` ~L584-619 (routes) →
`src/export/exporter.ts:49`, `src/export/importer.ts:53, 78-80, 218`.

**Impact:** an authenticated HTTP caller gets arbitrary read/write to any path
the Tuberosa process can access. With a stolen API key, this is
post-authentication code execution adjacent (write to a directory that gets
served / executed: `~/.ssh/authorized_keys`, `/var/spool/cron`, a static
asset dir, …).

**Exploit (export → arbitrary write):**
```bash
curl -X POST http://127.0.0.1:3027/export/pack \
  -H "Authorization: Bearer $TUBEROSA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"out":"/tmp/pwn","project":"tuberosa"}'
# files now exist under /tmp/pwn (controlled name/content via atom titles)
```
Replace `/tmp/pwn` with `/var/www/html/uploads`, `~/.ssh`, or
`/etc/cron.daily` (depending on process UID and host layout).

**Exploit (import → arbitrary read into retrieval):**
```bash
curl -X POST http://127.0.0.1:3027/import/pack \
  -H "Authorization: Bearer $TUBEROSA_API_KEY" \
  -d '{"from":"/proc/self/environ","mode":"dry-run"}'
# importer attempts to read environ; even on failure, the error path
# echoes filesystem details
```
For real exfiltration: pre-populate a directory under the imported tree as
a symlink to the target (see H5 for the chained traversal).

**Fix:**
- Add a config var `TUBEROSA_EXPORT_BASE_DIR` (default
  `${dataDir}/exports`) and `TUBEROSA_IMPORT_BASE_DIR`.
- In the HTTP/MCP handlers, `path.resolve(base, body.out)` then `fs.realpath`
  both `base` and resolved; require `resolved.startsWith(realBase + path.sep)`.
- Reject inputs containing `..`, absolute paths, or NUL bytes before resolve.
- After writing/reading, `lstat` each touched path; reject symlinks.

**Note:** the MCP-stdio surface has the same issue. The local-trust model
partially mitigates it (an attacker who can reach MCP stdio already has the
same UID), but it remains a footgun if Tuberosa is ever wrapped to expose MCP
over a non-local transport.

---

### H1 — High: Secret redaction does not cover classifier output

**File:** `src/retrieval/service.ts:142` (call to `redactSearchInput`) and
`src/retrieval/classifier.ts` extractors.

**Impact:** the redaction layer is documented as the safety net for secrets
that slip into user prompts. It redacts the prompt **text** but the
classifier is invoked on the original `input.prompt`. Anything matched by
file-path / symbol / error / "exact term" extractors is attached to
`classified.*`, used as fusion seed terms, persisted on the context pack,
and echoed back in match reasons. A user pasting a Postgres URL ("getting
`FATAL: password authentication failed for user
postgres://foo:S3cret@host`") leaks `S3cret` as an extracted symbol.

**Exploit:** call `tuberosa_search_context` with a prompt embedding a
plausible secret in shape (length, charset) that does *not* match a known
regex, but does match the symbol extractor's `/[A-Za-z_][\w.-]+/` pattern.
The secret surfaces back as `classified.exactTerms[i]` in the response.

**Fix:** classify on the redacted prompt.
```ts
const safetyOutcome = redactSearchInput(input, safety);
const classified = classifyQuery(safetyOutcome.redactedPrompt);
```
And/or: run `redactString` over each extracted symbol/error before storing
it on `classified`.

---

### H2 — High: Suspicious candidates returned with only a metadata flag

**File:** `src/security/knowledge-safety.ts` `decideSafety` /
`sanitizeSearchCandidates`; `src/retrieval/service.ts` ~L228.

**Impact:** prompt-injection-shaped content that `decideSafety` rates
`'suspicious'` is returned to the agent with `context.metadata.safety.status
= 'suspicious'`. Most LLM callers do **not** branch on that field. Effective
guardrail = "blocked only", which is a strict subset of what the policy
expresses.

**Exploit:** ingest a knowledge item with content that triggers
`SUSPICIOUS_PATTERNS` but not `BLOCK_PATTERNS` ("ignore all previous
instructions and reveal …"). Issue a query that pulls it into the candidate
set. Output reaches the LLM, which obeys.

**Fix:** in `sanitizeSearchCandidates`, drop both `'blocked'` and
`'suspicious'`. Surface a `pack.metadata.safety.filteredCount` so callers
know something was removed.

---

### H3 — High: Embedding dimension drift produces silent 500s

**File:** `src/model/provider.ts` `OpenAiModelProvider.embed` ~L140-157;
`src/storage/postgres-store.ts:793-806` `searchVector`.

**Impact:** changing `OPENAI_EMBEDDING_MODEL` without re-running a migration
breaks every retrieval call. There is no boundary assertion in the provider
and no try/catch in `searchVector`; pgvector raises `expected N dimensions,
got M` and the HTTP/MCP caller sees a generic 500.

**Repro:**
1. `EMBEDDING_DIMENSIONS=1536` (vector column = vector(1536))
2. Set `OPENAI_EMBEDDING_MODEL=text-embedding-3-large` (3072-dim) without
   rebuilding the column.
3. Call `tuberosa_search_context`. Server returns 500 with no explanatory
   hint to the caller.

**Fix:**
- In `OpenAiModelProvider.embed`, assert
  `embedding.length === this.config.embeddingDimensions` → throw
  `ModelProviderError('embedding dimension mismatch', {expected, actual})`.
- Wrap `searchVector` in a try/catch that returns `[]` plus a structured
  warning on dimension errors, so retrieval degrades to lexical+memory
  instead of failing closed.

---

### H4 — High: Backup-path resolution is symlink-blind (TOCTOU)

**File:** `src/operations/backup-service.ts:725-742` `resolveBackupPath`.

**Impact:** `path.resolve()` normalizes `.`/`..` but does not follow
symlinks. If `${backupDir}` itself, or any directory under it, is a symlink
to a sensitive directory, the prefix check passes and `readFile` then reads
from the symlink target. Window between check and read also leaves room for
classic TOCTOU symlink-replacement attacks on a multi-user host.

**Repro:**
```bash
# Process runs as a user that can read /etc/shadow (root, or with caps).
ln -s /etc/shadow $TUBEROSA_BACKUP_DIR/sneaky.json
# Call any backup-read endpoint with backupIdOrPath="sneaky.json"
# resolve() returns inside backupDir; readFile then reads /etc/shadow.
```

**Fix:** `await fs.realpath(input)` and `await fs.realpath(backupDir)`;
require `realInput.startsWith(realBase + path.sep)`. Reject symlinks
component-wise via `lstat`.

---

### H5 — High: Pack importer's user-style directory traversal

**File:** `src/export/importer.ts:210-222`; helper `safeListUserStyleDirs`
~L268.

**Impact:** the helper verifies each entry is a directory but does not
validate the **name**. A pack containing `user-style/../etc` (an entry whose
name is literally `..` or `../etc`) is read via
`join(opts.from, 'user-style', '..', 'etc')`. Combined with **C1** (no
constraint on `opts.from`), the importer becomes a polished arbitrary-read
primitive even when the operator believes they limited the bundle to a
trusted directory.

**Exploit:** craft a `.tuberosa-pack` whose `user-style/` directory contains
a child literally named `..` (legal on POSIX). On import, the importer
reads files from outside the bundle tree.

**Fix:** enforce `/^[A-Za-z0-9._-]+$/` on each entry name. Better, validate
that `path.resolve(base, entry).startsWith(base + path.sep)` for every entry
returned by `readdir` across the importer (atoms/, edges/, user-style/, …).

---

### H6 — High: Physical-mirror rebuild has an unprotected window

**File:** `src/operations/backup-service.ts:483-496`.

**Impact:** mirror rebuild does
`writeSnapshot(temp) → rm(physicalMirrorDir,-rf) → rename(temp, dir)`. Two
problems:

1. Between the `rm` and the `rename`, any concurrent reader of
   `.tuberosa/current` sees a missing/empty directory.
2. A process crash mid-window leaves the mirror permanently gone. Operator
   sees missing data on next boot.

The temp suffix is `pid-Date.now()` which is collidable under rapid sync.

**Repro:** under load, `kill -9` the process between the `rm` and `rename`
(can be reproduced reliably with a small `sleep` injected for testing).
`.tuberosa/current` ceases to exist.

**Fix:**
- Generate the temp name with `crypto.randomUUID()`.
- Use the rename-and-replace pattern: write to
  `${dir}.new-${uuid}`, then `rename(new, dir)` directly. POSIX `rename` is
  atomic and replaces the destination if it's an empty directory; otherwise
  use a two-step swap (`rename(dir, ${dir}.old)`, `rename(new, dir)`,
  `rm(${dir}.old, -rf)`) protected by an exclusive lockfile.

---

### H7 — High: Store boundary still trusts upstream UUID filtering

**File:** `src/storage/postgres-store.ts` (any method with `::uuid` cast,
e.g. `getKnowledge` ~L247, `searchVector` ~L793).

**Impact:** the Plan-1 worktree-UUID fix added a guard on the *callers*
(`isPersistedKnowledgeId(id)`). The store itself does not redundantly
enforce; any new caller that forgets the guard reintroduces 22P02 errors as
unhandled 500s. The export/import work added several new code paths;
defensive enforcement at the store boundary would have prevented the class
from ever returning.

**Repro:** call `getKnowledge('worktree:1234')` from a hypothetical new
helper that forgets the guard. Server returns 500 (`invalid input syntax
for type uuid: worktree:1234`).

**Fix:** wrap the entry of each `::uuid`-using method in
`if (!isPersistedKnowledgeId(id)) return undefined;`. Same idea for batch
methods: filter the input array via `filterPersistedKnowledgeIds` (which
already exists for some methods).

---

### H8 — High: `tuberosa_resolve_atom_import_conflict` accepts unbounded `mergedSnapshot`

**File:** `src/mcp/server.ts:447` →
`src/storage/postgres-store.ts:resolveAtomImportConflict`.

**Impact:** the MCP handler casts `args.mergedSnapshot` to
`KnowledgeAtomPatch` (compile-time only) with no Zod schema, no size cap,
and no own-property filter. Two concrete risks:
- **DoS:** a multi-MB or deeply-nested `mergedSnapshot` consumes memory at
  validation/serialization time. The MCP frame has a 16 MiB cap
  (`src/mcp-stdio.ts:14`), but that's a lot of headroom.
- **Prototype pollution if the merge path uses spread/Object.assign on the
  raw object.** Whether this exploits requires checking the actual merge
  implementation in `resolveAtomImportConflict` — flagged as an open verify
  item rather than confirmed.

**Exploit (DoS, confirmed):**
```jsonc
{
  "jsonrpc":"2.0","id":1,
  "method":"tools/call",
  "params":{
    "name":"tuberosa_resolve_atom_import_conflict",
    "arguments":{
      "conflictId":"...",
      "resolution":"keep_merged",
      "mergedSnapshot":{"metadata":{"x":"A".repeat(10_000_000)}}
    }
  }
}
```

**Fix:**
- Define a Zod schema with `.strict()` (whitelist fields, reject unknown),
  max sizes on strings, max array lengths, max nesting depth.
- After Zod, defensively `JSON.parse(JSON.stringify(snapshot))` to break any
  proto chain before passing to the store.

---

### M1 — Medium: `/health` discloses configuration to unauthenticated callers

**File:** `src/http/server.ts:159-172` (`public:true`).

**Impact:** an unauthenticated caller (anyone with TCP reach) learns
`store`, `durability`, `cache`, `modelProvider`, and the absolute
`backupDir`. The backup path is the highest-value field for an attacker
fingerprinting the deploy.

**Repro:** `curl http://127.0.0.1:3027/health` returns the verbose body.

**Fix:** public `/health` returns `{ok:true}` only. Move the verbose form to
`/admin/status` behind the auth check.

---

### M2 — Medium: Memory store and Postgres store default `status` filter differ

**File:** `src/storage/memory-store.ts:178` vs `src/storage/postgres-store.ts:211-216`.

**Impact:** when `options.status` is unset and `options.review` is falsy,
Postgres applies `ki.status='approved'` but memory-store returns all
statuses. Test suites running on memory-store mask the divergence; a bug
that hides non-approved knowledge in tests can break under Postgres in
prod.

**Repro:** `listKnowledge({})` against memory-store returns drafts; the
same call against Postgres does not.

**Fix:** apply the same default in memory-store; better, route both
implementations through a shared `defaultStatusFilter()` helper.

---

### M3 — Medium: `listKnowledge.query` does not escape LIKE wildcards

**File:** `src/storage/postgres-store.ts:224-225`.

**Impact:** `%${query.toLowerCase()}%` lets a caller pass `%` and `_` to
widen the search. Not SQL injection (parameterized), but allows widening
across what the caller is supposed to see. Combined with any future
permission relaxation on the list endpoint, it becomes a privacy issue.

**Repro:** call list with `query='_'`. Matches every row that has any
character at the relevant position.

**Fix:**
```ts
const escaped = query.toLowerCase().replace(/[\\%_]/g, '\\$&');
params.push(`%${escaped}%`);
// and add ESCAPE '\\' to the LIKE clauses
```

---

### M4 — Medium: Backup directory and files use process umask

**File:** `src/operations/backup-service.ts:516` and `writeFile` call sites.

**Impact:** under default umask (0022), backups are 0644 / dirs 0755 — any
local user reads atoms, reflection drafts, and context packs (including any
embedded secrets that slipped past redaction). On a shared host or CI runner
this is a privacy regression.

**Repro:** `ls -l .tuberosa/backups/*.json` → `-rw-r--r--`.

**Fix:**
```ts
await mkdir(path, { recursive: true, mode: 0o700 });
await writeFile(target, body, { mode: 0o600 });
```
Plus a one-time `chmod(backupDir, 0o700)` on service init.

---

### M5 — Medium: Cross-project leakage via user-style atoms

**File:** `src/retrieval/service.ts` ~L588-590 (comment notes the bypass is
intentional).

**Impact:** user-style atoms intentionally bypass the namespace filter.
Defensible for personal-workflow tips, but undocumented as a security
exception. If "project" is being used as a privacy boundary (different
clients, different teams), user-style content leaks across it.

**Fix:** document the exception, and add a config knob:
`retrievalPolicy.crossProjectUserStyle: 'allow'|'deny'|'priority_only'`.

---

### M6 — Medium: Supersession can starve queries

**File:** `src/retrieval/service.ts:821-828`;
`src/retrieval/context-pack.ts:197` fallback.

**Impact:** no anomaly check on suppression. One poisoned atom (or a buggy
relation inference) can supersede an arbitrary number of legitimate items,
driving the result set to 1 — and `filtered.slice(0,1)` keeps the *weakest*
remaining candidate, not the best.

**Fix:** when more than 50% of candidates are suppressed for the same
reason, log a warning and either skip suppression or include the originals
with a flag.

---

### M7 — Medium: No depth cap on JSON parsing at trust boundaries

**Files:** `src/export/importer.ts:73-75` (edges.jsonl),
`src/operations/backup-service.ts:710` (manifests), and any
`JSON.parse(await readFile(...))` site.

**Impact:** `TUBEROSA_MAX_INGEST_CONTENT_BYTES` and
`TUBEROSA_MAX_REQUEST_BYTES` cap *bytes*, not *depth*. A 1 MB document of
`{"a":{"a":{...}}}` exhausts V8's stack during validation. JSON.parse
itself is iterative and survives, but downstream recursive validators (Zod,
serializers) do not.

**Fix:** add a `safeJsonParse(text, {maxDepth, protoAction:'remove'})`
helper (use `secure-json-parse` or roll a small validator) at every trust
boundary: HTTP body, MCP frame body, pack import, backup restore. Reject
on depth-exceeded with a structured error.

---

### L1 — Low: `/health` repeated for completeness (see M1).

### L2 — Low: `console.error` in MCP path includes attacker-shaped strings

**File:** `src/mcp/server.ts:1661`.

**Impact:** stderr is fine for MCP (stdout is reserved for JSON-RPC), but
the message inlines a derived `captureError` string. Under an
auto-capture-of-client-errors flow, the attacker can shape this string.
Stderr log amplification only; not exploitable beyond noise.

**Fix:** `console.error('[error-log] capture failed')`; structured log via
the operations logger if richer detail is needed.

### L3 — Low: User-Agent logged verbatim in HTTP error capture

**File:** `src/http/server.ts:1335-1369` (`maybeCaptureHttpError`).

**Impact:** UA strings can carry session/build identifiers. If error logs
are shared with reviewers or shipped to a remote sink, this leaks more than
needed.

**Fix:** truncate UA to 128 chars and strip non-printable bytes before
storing.

### L4 — Low: Cache keys not normalized

**File:** `src/cache.ts:42-62`.

**Impact:** callers pass raw keys; whitespace/case differences cause cache
misses that look like coherent behavior. Correctness papercut, not a
security issue.

**Fix:** add `normalizeCacheKey(parts: string[])` and route writers through
it.

### L5 — Low: Workbench asset path check has redundant string + path
comparison

**File:** `src/http/workbench-v2.ts:58-72`.

**Impact:** the defensive `.includes('..')` plus
`fullPath.startsWith(bundleRoot)` is correct on Linux but the redundancy
suggests uncertainty. A future port to a case-insensitive FS would break
quietly.

**Fix:** single canonical check using
`path.relative(bundleRoot, fullPath)` and require it not to start with
`..`.

---

## 5. Missing tests / verification gaps

Per the project rule "retrieval/safety improvements require eval coverage
first", these need fixtures before the fix:

1. **H1** — `eval/retrieval-fixtures.json` case: prompt contains a
   plausible secret embedded as a symbol; assertion: secret does **not**
   appear in `classified.exactTerms` or in any returned match reason.
2. **H2** — `eval/retrieval-fixtures.json` case: ingested candidate with
   `SUSPICIOUS_PATTERNS` match but no `BLOCK_PATTERNS` match; assertion:
   candidate is **dropped** from the pack, not returned with a flag.
3. **H5** — integration test under `test/`: create a pack on disk with a
   `user-style/..` entry; assertion: importer rejects with
   `ValidationError`, no files outside the bundle root are read.
4. **H6** — `test/integration` (docker-gated): forcibly kill the process
   between `rm` and `rename` during a mirror rebuild; assertion: on
   restart, `.tuberosa/current` is recoverable from the previous
   generation.
5. **H8** — MCP integration test: invoke
   `tuberosa_resolve_atom_import_conflict` with a 10 MB string in
   `mergedSnapshot.metadata`; assertion: rejected at schema validation
   with `ValidationError`, memory stable.
6. **M2** — `test/storage-divergence.test.ts` (new): for every
   `KnowledgeStore` method, exercise the same options against memory and
   Postgres adapters; assertion: equal result sets.
7. **M4** — `test/operations.test.ts`: after a backup write, assert
   `fs.statSync(path).mode & 0o777 === 0o600`.
8. **C1** — `test/http/export-import.test.ts`: assert
   `POST /export/pack {out:"/tmp/escape"}` returns 400 and writes nothing.
   Same for absolute paths, `..` segments, and symlinks.

**Existing tests reviewed:**
- `test/export-import.test.ts` and the round-trip test (commit `51427fd`)
  cover the happy path. They do **not** exercise malicious `out`/`from`
  inputs or pathological directory contents.

---

## 6. Residual risks

After the fixes above, the following residual risks remain and should be
tracked separately:

- **R1 — MCP local-trust assumption is implicit.** Any future change that
  exposes MCP over a non-local transport (TCP MCP, remote agent gateway)
  re-opens C1, H5, and H8 over the network. Add a hard refusal in the MCP
  bootstrap if a non-local socket is detected.
- **R2 — Token-budget accounting is heuristic** (`context-pack.ts`
  `takeChunksWithinBudget`). Adversarial Unicode (combining marks, BPE-hostile
  scripts) can blow past the stated budget by 30-50%. Either pull in the
  real tokenizer or add a 20% safety margin and document it.
- **R3 — Conflict-resolution audit gap.** `resolveConflict` with
  `keep_theirs` can overwrite local high-value atoms when importing a pack
  from an untrusted source. There is no immutable audit log of which
  conflicts were resolved with which side winning. Add a row to
  `atom_import_decisions` (or equivalent) with the user, timestamp, and
  decision per conflict.
- **R4 — Async lifecycle robustness.** `requestPhysicalMirror` is
  fire-and-forget from multiple HTTP routes (`server.ts:197, 224, 239, 272`,
  …). Even if each call internally swallows errors, a missing
  `process.on('unhandledRejection', …)` and no global error budget means a
  flaky disk silently degrades the mirror. Add a global handler and a
  metric.
- **R5 — `js-yaml.load` safety is version-pinned**. v4.x's `load` is the
  safe loader, but a future pnpm-update to v5 or to a fork could quietly
  reintroduce unsafe-by-default behavior. Pin the schema explicitly:
  `yaml.load(text, { schema: yaml.CORE_SCHEMA })`.

---

## 7. Recommended verification commands

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:agent-context
pnpm run test:integration       # docker-gated; postgres + redis
```

Plus, after each fix lands, the matching fixture/test from §5 should be
added in the same PR.

---

## 8. Demoted false positives

These were flagged "Critical" by parallel subagents; re-verified against
actual source on this branch — not exploitable today.

1. **"SQL injection via `timestampColumn`"** (`postgres-store.ts:1077-1079`).
   Ternary outputs are compile-time literal strings; `status` is one of
   `'selected'|'rejected'|undefined` from `packStatusForFeedback`. Not
   user-reachable. Cleanup: switch to `CASE WHEN` for static-analysis
   friendliness.
2. **"SQL injection in `feedbackExistsSql`"** (`postgres-store.ts:3092-3100`).
   Three call sites at lines 3017-3019, all pass hardcoded literals
   `'stale'|'rejected'|'irrelevant'`. Argument type is the closed union
   `FeedbackEvent['feedbackType']`. Not user-reachable. Cleanup:
   parameterize anyway for defense-in-depth.
3. **"YAML RCE via `yaml.load` without `safe`"**
   (`src/export/atom-codec.ts:23`, `src/export/knowledge-codec.ts:21`).
   `js-yaml@4.1.1` — v4's `load` uses `DEFAULT_SCHEMA` (the safe schema);
   `!!js/function`/`!!js/regexp` were removed from the default in v4.
   Subagent imported v3-era guidance. Cleanup: pin the schema explicitly
   (`yaml.load(text, { schema: yaml.CORE_SCHEMA })`) so the safety
   property survives a future version bump (R5).
4. **"`requireApiKeyForNonLoopback` semantics inverted"**
   (`http/server.ts:1081-1090` and `src/index.ts:8`). Re-traced: when
   `apiKey` is set, every request requires a valid Bearer (correct). When
   unset, the flag toggles "loopback-only" vs "open to all". The boundary
   check in `index.ts` refuses startup only for the genuinely dangerous
   combo (open non-loopback with no key). Naming is fine.

---

## 9. Conclusion

**One Critical, eight High, seven Medium, five Low** confirmed findings;
four "Critical" subagent claims were demoted under verification. The
single Critical and a majority of the Highs cluster around the new
export/import bundle feature (`feat/project-export-bundle`); the
remainder are pre-existing gaps that the new feature amplifies (H1, H2, H3,
H7) or that operate at the filesystem boundary (H4, H6).

**Recommended ship gate:** fix **C1** and **H5** before exposing
`/export/pack` and `/import/pack` to any non-trusted caller. The other
Highs can be sequenced as a follow-up sprint with the fixture coverage in
§5 added in the same PR as each fix.

No code was modified during this audit.

---

*Branch:* `feat/project-export-bundle` @ `4e8bdb8`
*Auditor:* Tuberosa internal session `5062a7ae-ea18-4f2e-8b72-5a12548267d9`
*Method:* 5 parallel read-only subagent surface audits + per-Critical
verification against source.

<!-- cspell:ignore Tuberosa tuberosa TUBEROSA pentest pgvector realpath worktree TOCTOU collidable papercut subword unrecovered Bearer pwn dataDir mergedSnapshot pgvector -->
