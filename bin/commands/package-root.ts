import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsAdapter } from './types.js';

/**
 * Resolve the installed Tuberosa **package root** — the directory that owns the
 * package's own assets: `migrations/`, the compiled `dist/`, and the MCP
 * entrypoint (`dist/src/mcp-stdio.js` or `src/mcp-stdio.ts`).
 *
 * This is deliberately DISTINCT from the user's **project root** (cwd / `--root`),
 * where project-owned files live: `.tuberosa/compose.yml`, `.env`, and the
 * destination `.claude/skills/`. Conflating the two is what broke `npx tuberosa`
 * from a foreign project — the CLI looked for its own bundled files inside the
 * user's project and never found them.
 *
 * Resolution order:
 *   1. `TUBEROSA_PACKAGE_ROOT` env var — escape hatch + test seam.
 *   2. Module-relative candidates: from `bin/commands/package-root.{ts,js}` the
 *      package root is two levels up in a tsx checkout, or three levels up when
 *      running from compiled `dist/bin/commands/`. The first candidate that
 *      actually contains a `package.json` wins.
 *
 * Mirrors the source-resolution strategy already used for bundled skills, so the
 * package's `files` allowlist and the runtime resolver stay in lock-step.
 */
export async function resolvePackageRoot(
  env: Record<string, string | undefined>,
  fs: FsAdapter,
): Promise<string | undefined> {
  const override = env.TUBEROSA_PACKAGE_ROOT;
  const candidates = override ? [override] : packageRootCandidates();
  for (const candidate of candidates) {
    if (await fs.exists(`${candidate}/package.json`)) return candidate;
  }
  return undefined;
}

/** Module-relative guesses for the package root (tsx checkout and compiled dist). */
export function packageRootCandidates(): string[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
      resolve(here, '../..'), // bin/commands → repo root (tsx checkout)
      resolve(here, '../../..'), // dist/bin/commands → package root (compiled)
    ];
  } catch {
    return [];
  }
}
