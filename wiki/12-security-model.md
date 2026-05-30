# 12 — Security Model

Tuberosa is **local-first by default**. The threat model assumes (a) the operator runs the process locally, (b) the MCP client lives on the same machine and is trusted, and (c) the HTTP surface is loopback-only unless explicitly opened.

The audit at [docs/audit-specs/SECURITY_AUDIT_2026-05-28.md](../docs/audit-specs/SECURITY_AUDIT_2026-05-28.md) is the live record of findings and remediations. Phase 1 (C1 + H5) is shipped; Phases 2–5 are queued (see follow-up plans under `docs/superpowers/plans/`).

## Threat model summary

| Actor | What they can do | Mitigation |
|---|---|---|
| Local same-UID user | Anything Tuberosa can. | None — that's the trust assumption. |
| Local other-UID user | Read backup files / mirror state. | M4 in audit (backup file perms, queued for fix). |
| Authenticated HTTP client | Within their key's scope. | API key gate (`TUBEROSA_API_KEY`); path confinement on export/import (shipped). |
| Network observer (loopback only) | Fingerprint deployment. | M1 in audit (`/health` info disclosure, queued for fix). |
| Malicious knowledge supplier | Inject prompt-injection / secrets into ingested content. | `knowledge-safety.ts` redacts + blocks (H1, H2 queued for hardening). |
| Malicious pack author | Read arbitrary files via crafted pack. | C1 + H5 closed by Phase 1 (path confinement + child-name validation). |
| Operator with config drift | Silent 500s on dim change. | H3 queued (assert dimension at boundary). |

## Auth

### API key

Set `TUBEROSA_API_KEY` to require auth on every route except `/health`:

```
Authorization: Bearer <api-key>
# or
X-Tuberosa-Api-Key: <api-key>
```

Both compared in constant time via SHA-256 + `timingSafeEqual` (`src/http/server.ts` `secureEqual`).

### Boundary check (`src/index.ts:8`)

The server **refuses to start** when all three hold:

- `TUBEROSA_HTTP_HOST` is not loopback (`127.0.0.1`, `::1`, `localhost`).
- `TUBEROSA_API_KEY` is unset.
- `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` is `false`.

This is the only catastrophic combo (open to the network with no auth). Other combinations are allowed; runtime auth then enforces:

| `apiKey` set? | `requireApiKey…` | Loopback request | Non-loopback request |
|---|---|---|---|
| Yes | (any) | Requires bearer | Requires bearer |
| No | true | Allowed | Refused 401 |
| No | false | Allowed | **Refused at startup** by the boundary check (unless host is loopback). |

### MCP

MCP stdio has no per-call auth — the local process is the trust boundary. **If you ever wrap MCP over a network transport**, re-evaluate every tool: C1, H5, and H8 (oversized `mergedSnapshot`) all become network-reachable.

## Secret redaction

`src/security/knowledge-safety.ts` runs on both ingestion **and** retrieval inputs:

- **Patterns matched** (non-exhaustive): bearer tokens, JWTs, Postgres URLs with passwords, basic-auth URLs, GitHub/AWS/Google/Stripe/Slack key shapes, `-----BEGIN ...` private keys.
- **Where**: `redactString` on knowledge content before storage; `redactSearchInput` on search prompts before embedding.

**Known gap (H1, queued):** the classifier currently extracts symbols/errors from the *original* prompt, not the redacted one. A secret that survives as a "symbol" can re-appear in `classified.exactTerms`. Until H1 ships, treat the classified block as semi-trusted.

## Prompt-injection guard

`decideSafety` (same file) classifies content into `safe | suspicious | blocked`:

- `blocked` content is dropped at ingestion.
- `suspicious` content is flagged but currently still returned in retrieval (H2, queued — Phase 2 will drop `suspicious` too).

Patterns include `ignore (all )?previous instructions`, `reveal (the )?system prompt`, role-impersonation phrases.

## Path confinement (Phase 1 — shipped 2026-05-29)

Every export/import path on both HTTP and MCP runs through `assertSafeBundlePath(base, candidate)` from `src/security/safe-paths.ts`:

| Rejects | Reason |
|---|---|
| Absolute paths | `out: "/etc/cron.daily/evil"` |
| `..` segments | `out: "../../escape"` |
| NUL bytes | `out: "has\0nul"` |
| Symlink subtrees that escape base | `lstat` per component |
| Resolved paths outside `base + path.sep` | `path.realpath` + prefix check |

Bases:

```
TUBEROSA_EXPORT_BASE_DIR=.tuberosa/exports
TUBEROSA_IMPORT_BASE_DIR=.tuberosa/imports
```

Plus `assertSafeChildName` rejects any `user-style/<entry>` or `*.md` filename that:

- Contains `/`, `\`, or NUL.
- Equals `.` or `..`.
- Starts with `..` (defensive guard for unusual filenames).
- Doesn't match `/^[A-Za-z0-9._-]+$/`.

Test coverage: `test/safe-paths.test.ts` (7 unit tests), `test/export-import-security.test.ts` (10 integration tests through HTTP + MCP).

## Cross-project user style

User-style atoms (`scope: "user"`) **intentionally bypass** the project namespace filter (`src/retrieval/service.ts`). Defensible for personal workflows; a privacy exception if "project" is being used as a tenant boundary.

To restrict: a `retrievalPolicy.crossProjectUserStyle: "allow" | "deny" | "priority_only"` knob is on the Phase 2 roadmap (audit M5).

## Logging hygiene

- MCP stderr-only logs may include attacker-shaped strings in error capture paths (audit L2, queued).
- HTTP error capture stores `User-Agent` verbatim (audit L3, queued — truncate to 128 bytes).
- The cache abstraction does not normalize keys (audit L4 — correctness papercut, not security).

## Embedding dimension drift (audit H3, queued)

If you change `OPENAI_EMBEDDING_MODEL` without running a migration, the `vector(N)` column dimension and the embedding length will disagree. The next retrieval call throws `vector dimension mismatch` and the HTTP/MCP caller sees a generic 500. Phase 2 will add a boundary assertion in `OpenAiModelProvider.embed` and a graceful fallback in `searchVector`.

## Audit history

| Audit | File | Highlights |
|---|---|---|
| 2026-05-28 | [docs/audit-specs/SECURITY_AUDIT_2026-05-28.md](../docs/audit-specs/SECURITY_AUDIT_2026-05-28.md) | 1 Critical (C1, closed), 8 High (H5 closed; H1–H4, H6–H8 queued), 7 Medium, 5 Low. |

## What to read

- [08-export-import-bundle.md](08-export-import-bundle.md) — path confinement in context.
- [11-configuration.md](11-configuration.md#security) — all security env vars.
- [docs/audit-specs/SECURITY_AUDIT_2026-05-28.md](../docs/audit-specs/SECURITY_AUDIT_2026-05-28.md) — every finding with file:line refs.
- [docs/superpowers/plans/2026-05-28-security-audit-remediation.md](../docs/superpowers/plans/2026-05-28-security-audit-remediation.md) — Phase 1 plan + follow-up plan stubs.
