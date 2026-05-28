# Tuberosa Wiki

Full guides for Tuberosa. Start with [01-getting-started](01-getting-started.md). Each guide is self-contained but links freely to siblings.

| # | Guide | Use for |
|---|---|---|
| 01 | [Getting Started](01-getting-started.md) | Install, first ingest/search/feedback, first agent session. |
| 02 | [Architecture](02-architecture.md) | Components and where they live in `src/`. |
| 03 | [Knowledge Model](03-knowledge-model.md) | Knowledge items, labels, references, relations. |
| 04 | [Retrieval Pipeline](04-retrieval-pipeline.md) | The 10-step pipeline in depth. |
| 05 | [Agent Session Lifecycle](05-agent-session-lifecycle.md) | Sessions, decisions, learning signals, finish. |
| 06 | [Reflection Memory](06-reflection-memory.md) | Draft → reviewed memory flow, write-gate. |
| 07 | [Atoms and User-Style](07-atoms-and-user-style.md) | Atom tiers, critic, archival, impact analysis, user-style layer. |
| 08 | [Export / Import Bundles](08-export-import-bundle.md) | `.tuberosa-pack` format, conflict resolution, base-dir confinement. |
| 09 | [MCP Reference](09-mcp-reference.md) | Every MCP tool with arguments and examples. |
| 10 | [HTTP API Reference](10-http-api-reference.md) | Full HTTP route reference. |
| 11 | [Configuration](11-configuration.md) | Every env var documented. |
| 12 | [Security Model](12-security-model.md) | Threat model, redaction, prompt-injection, path confinement, residual risks. |
| 13 | [Operations Runbook](13-operations-runbook.md) | Backups, mirror, evals, integration tests, common ops. |
| 14 | [Development & Extension](14-development-and-extension.md) | Sandbox, calibrate-fusion, adding tools/routes, hooks. |

Cross-cutting documents in the main repo:

- [`README.md`](../README.md) — one-page overview.
- [`docs/tuberosa-project.md`](../docs/tuberosa-project.md) — original design notes.
- [`docs/audit-specs/SECURITY_AUDIT_2026-05-28.md`](../docs/audit-specs/SECURITY_AUDIT_2026-05-28.md) — latest security audit.
- [`docs/superpowers/plans/`](../docs/superpowers/plans/) — implementation plans (active and historical).

## Conventions used in the wiki

- **File paths** are relative to the repo root.
- Line numbers (`src/file.ts:NNN`) are accurate at time of writing; verify with `git grep` if a section is older than a few weeks.
- Examples favour `curl` over a typed client to stay framework-agnostic.
- `<placeholders>` in commands need substitution; do not paste them verbatim.
- Diagrams use ASCII so they render in any pager or browser.
