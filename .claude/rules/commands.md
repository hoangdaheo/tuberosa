# Rule: Commands

```bash
pnpm install              # Install dependencies (requires Node 22+, pnpm 11+)
pnpm run build            # TypeScript compile to dist/
pnpm test                 # Full unit test suite (all test/*.test.ts)
pnpm run dev              # HTTP server in watch mode (port 3027)
pnpm run migrate          # Apply SQL migrations to Postgres
pnpm run eval:retrieval   # Deterministic retrieval quality eval (must pass before merging retrieval changes)
pnpm run eval:agent-context # Agent session compliance eval
pnpm run sandbox          # Knowledge-mapping sandbox: tiered synthetic corpus + golden prompts + per-source ablation. Emits eval/sandbox/report.md.
pnpm run sandbox:ablate   # Sandbox with per-source ablation rows (lexical/vector/metadata/memory/graph each disabled in turn)
pnpm run calibrate-fusion # Phase 4: re-run the sandbox and emit a calibrated config/retrieval-policy.json patch (sourceWeights + per-task profiles)
pnpm run test:integration # Docker-gated Postgres + Redis integration tests (skips if stack is down)
pnpm run verify:bundled-skills # Prepack gate: bundled-skills manifest ↔ package.json files ↔ on-disk parity + consumer-safety grep
```

Run a single test file:
```bash
TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/retrieval.test.ts
```

Node version: `.nvmrc` pins `22.21.1`. If the shell uses an older version, prefix commands:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

Docker stack (Postgres + Redis + HTTP server with auto-migration):
```bash
docker compose up --build -d
docker compose down -v    # also removes Postgres data
```

Local no-dependency mode (no Postgres, no Redis, data lost on exit):
```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

> Do not run multiple `pnpm` commands concurrently — pnpm workspace state has previously produced transient JSON parse failures during concurrent runs.
