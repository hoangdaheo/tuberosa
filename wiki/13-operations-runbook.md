# 13 — Operations Runbook

Day-to-day operational recipes: backups, mirror, evals, integration tests, troubleshooting.

## Backups

Backups are JSON snapshots of every store table, written to `TUBEROSA_BACKUP_DIR` (default `.tuberosa/backups/`). Filename pattern: `backup-<ISO-timestamp>-<reason>.json`.

### Scheduled

Set in env:

```
TUBEROSA_BACKUP_INTERVAL_SECONDS=3600          # cadence
TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS=60       # wait before first run
TUBEROSA_BACKUP_RETENTION_COUNT=24
TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS=30
```

The scheduler runs inside the HTTP server (`services.operations.startScheduledBackups()` in `src/index.ts`).

### On demand

```bash
curl -sX POST http://localhost:3027/operations/backups -d '{"reason":"pre-migration"}'
```

CLI alias:

```bash
pnpm run backup
```

### List / status / prune

```bash
curl -s http://localhost:3027/operations/backups
curl -s http://localhost:3027/operations/backups/status
curl -sX POST http://localhost:3027/operations/backups/prune
```

### Restore

```bash
pnpm run restore -- --backup .tuberosa/backups/backup-2026-05-28T10-00-00Z-scheduled.json
```

Restore is destructive — it truncates the relevant tables and reinserts from the snapshot. Always take a fresh backup first.

### Permissions

Backups currently use process umask (default 0644). Audit finding M4 (queued) recommends `0o600` files and `0o700` dirs. On a multi-user host, set the parent dir mode by hand:

```bash
chmod 700 .tuberosa/backups
```

## Physical mirror

The mirror writes the same data the store holds, in human-readable Markdown + JSONL, to `.tuberosa/current/`. Tooling reads it without going through Postgres.

Toggles:

```
TUBEROSA_PHYSICAL_MIRROR_ENABLED=true
TUBEROSA_PHYSICAL_MIRROR_DIR=.tuberosa/current
TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS=500
```

The mirror rebuilds via a temp-then-rename pattern (`src/operations/backup-service.ts`). Audit finding H6 (queued) replaces the current "rm → rename" sequence with a safer two-step swap.

## Eval gates

Run **before** any change to retrieval, classifier, fusion, reranker, or context-pack code:

```bash
pnpm run eval:retrieval                              # must hit hitRate=1, staleRejection=1
pnpm run eval:retrieval -- --top-k 3
pnpm run eval:retrieval -- --fixture eval/retrieval-fixtures.json --fail-under-hit-rate 0.95
pnpm run eval:agent-context                          # session compliance
pnpm run eval:knowledge-completeness
pnpm run eval:context-mapping
pnpm run eval:safety
```

`pnpm run eval:retrieval` is the **hard merge gate** for retrieval-pipeline changes (see CLAUDE.md). Adding a new heuristic without a failing fixture is a rejected pattern.

## Sandbox & calibration

For tuning fusion weights and task profiles:

```bash
pnpm run sandbox                  # tiered synthetic corpus + golden prompts
pnpm run sandbox:ablate           # disable each retrieval source in turn
pnpm run calibrate-fusion         # emit a calibrated config/retrieval-policy.json patch
```

`sandbox:ablate` is the fastest way to spot a source that's not pulling its weight (or is *too* load-bearing).

## Integration tests

```bash
pnpm run test:integration
```

Probes Postgres + Redis first; skips (doesn't fail) if the stack is down. Defaults:

```
TUBEROSA_INTEGRATION_DATABASE_URL=postgres://tuberosa:tuberosa@localhost:5432/tuberosa
TUBEROSA_INTEGRATION_REDIS_URL=redis://localhost:6379
```

The Postgres test seeds a unique project, exercises pgvector + FTS, records context-pack feedback. The Redis test verifies JSON set/get/delete through `RedisCache`.

## Self-ingest

```bash
pnpm run seed:self                                     # standard self-ingest
node --import tsx scripts/seed-tuberosa-knowledge.ts    # full coverage (all src/ + docs/ recursive)
```

The extended seed wraps each file in its own try/catch — the ingestion service is sequential and would otherwise abort the whole batch on a single rejection. **Always exclude `src/security/knowledge-safety.ts`** — its own pattern strings trip its own guard.

## Session replay

Inspect a recorded agent session over HTTP:

```bash
curl -s http://localhost:3027/operations/session/<sessionId>/replay
```

## Error logs

| Operation | CLI |
|---|---|
| List open logs | `pnpm run error-logs` |
| Capture (programmatic) | `tuberosa_record_error_log` (MCP) / `POST /operations/error-logs` (HTTP) |
| Resolve | `POST /operations/error-logs/{id}/resolve` |
| Convert to reflection draft | `tuberosa_create_error_log_reflection_draft` |

Logs live under `TUBEROSA_ERROR_LOG_DIR` (default `.tuberosa/error-logs/`). Auto-capture is on by default for HTTP/MCP server errors.

## Maintenance

```bash
curl -sX POST http://localhost:3027/operations/maintenance/preview -d '{"project":"tuberosa","kinds":["dedup","decay","relink"]}'
curl -sX POST http://localhost:3027/operations/maintenance/apply -d '{"planId":"<from-preview>"}'
```

Plans are previewed first (no writes), then applied separately.

## Project lifecycle (sync / atlas / bootstrap)

Keep a project's knowledge in step with its files, then make it readable. Full guides: [15](15-source-lifecycle-sync.md), [16](16-project-atlas.md), [17](17-bootstrap-and-export-v2.md).

```bash
# First run on a fresh repo — sync + atlas + health + next actions in one go
tuberosa bootstrap --project tuberosa

# Hand another team a readable + importable pack
tuberosa bootstrap --project tuberosa --export        # → .tuberosa/exports/tuberosa-bootstrap/

# Day-to-day: keep knowledge current
tuberosa sync --project tuberosa                      # dry-run plan (safe)
tuberosa sync --project tuberosa --apply              # apply additive ops; deletions deferred
tuberosa sync --project tuberosa --apply --yes        # also archive deleted-file knowledge

# Auto-sync on every commit/merge (additive only; deletions queued for review)
tuberosa hook install --project tuberosa

# Regenerate the readable atlas on demand
tuberosa atlas --project tuberosa --write             # → .tuberosa/atlas/*.md
```

Two files to know:

- `.tuberosa/pending-sync.json` — deletions detected but **not** archived (from the git hook or `--apply` without `--yes`). Clear it by running `tuberosa sync --apply --yes` after review.
- `.tuberosa/atlas/*.md` — the five atlas files; auto-refreshed after every `sync --apply` (toggle with `TUBEROSA_ATLAS_AUTO_REGEN`).

> **Safety:** sync never hard-deletes. Deleted-file knowledge is *archived* (tombstoned) and resurrectable via `tuberosa_resurrect_atom`. Archiving always needs explicit confirmation; the git hook never archives.

## Common commands cheat-sheet

```bash
pnpm run build           # TypeScript compile
pnpm test                # full unit suite
pnpm run dev             # HTTP server in watch mode
pnpm run mcp             # MCP stdio server
pnpm run migrate         # apply SQL migrations
pnpm run worker          # background worker

tuberosa bootstrap --project tuberosa            # first-run: sync + atlas + health
tuberosa sync --project tuberosa [--apply --yes] # source lifecycle sync
tuberosa atlas --project tuberosa --write        # regenerate the project atlas

pnpm run backup
pnpm run restore -- --backup <path>
pnpm run error-logs
pnpm run context-quality -- --project tuberosa

pnpm run eval:retrieval
pnpm run eval:agent-context
pnpm run test:integration

pnpm run sandbox
pnpm run sandbox:ablate
pnpm run calibrate-fusion
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` or pnpm fails on Node 20 | `nvm use` then `corepack enable && pnpm install`. `.nvmrc` pins 22.21.1. |
| pnpm tries to use a global store | `pnpm config set store-dir .pnpm-store --location project && pnpm install`. |
| Docker app exits during migration | `docker compose logs --no-color app worker` then `docker compose up --build -d`. |
| App refuses to start: "Refusing to start: TUBEROSA_HTTP_HOST=0.0.0.0 …" | Set `TUBEROSA_API_KEY` (recommended) or set `TUBEROSA_HTTP_HOST=127.0.0.1`. |
| `/operations/export-pack` returns 400 "absolute path is not allowed" | Use a path relative to `TUBEROSA_EXPORT_BASE_DIR` (default `.tuberosa/exports`). |
| `curl localhost:3027` fails in a sandbox | Run from an env allowed to bind/access local ports. |
| `vector dimension mismatch` errors | `EMBEDDING_DIMENSIONS` must equal the `vector(N)` in `migrations/001_init.sql`. |
| OpenAI embeddings fail | Verify `TUBEROSA_MODEL_PROVIDER=openai`, `OPENAI_API_KEY` set, model dimensions match. |
| MCP client sees no tools | Use absolute repo path, check the command's `PATH` for Node/pnpm, verify with MCP Inspector, ensure stdout is JSON-RPC only. |
| `DuplicateIngestionError` on re-ingest | Expected — `DuplicateDetector` auto-rejects textual + semantic duplicates. Treat as skip. |
| `pnpm test` hangs | Likely a lingering HTTP server from a test that didn't `await server.close()`. Use `--test-timeout 60000` to surface it; check `test/export-import-security.test.ts` pattern. |

## GitNexus integration

If GitNexus is installed for this repo, run:

```bash
npx gitnexus analyze        # rebuild the symbol/relationship index
npx gitnexus status         # check freshness
```

When the hooks report "GitNexus index is stale", the warnings are informational — they don't block writes. Re-analyse before doing impact analysis or symbol-aware refactors.

## Read next

- [11-configuration.md](11-configuration.md) — every env var.
- [12-security-model.md](12-security-model.md) — threat model and recent audit.
- [14-development-and-extension.md](14-development-and-extension.md) — adding tools, routes, and hooks.
