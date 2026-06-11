/**
 * Spec B — `tuberosa mcp install`: write agent MCP configs so users never
 * hand-edit them from a printed snippet.
 *
 * Targets: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) always;
 * `~/.codex/config.toml` (Codex) only when `~/.codex/` already exists.
 *
 * Merge, never clobber: JSON files are parsed and only the
 * `mcpServers.tuberosa` entry is added/replaced; every other key and server
 * is preserved. Unparseable JSON is refused — we print the snippet instead of
 * risking someone's config. TOML is append-only (no TOML dependency): we add
 * our own marked section, and never rewrite TOML we didn't author.
 *
 * The env block intentionally duplicates `buildEnv()`'s defaults: the config
 * file is self-documenting and survives future default changes.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildServerEntry(options: { postgresPort: number; redisPort: number }): McpServerEntry {
  return {
    command: 'npx',
    args: ['tuberosa', 'mcp'],
    env: {
      TUBEROSA_STORE: 'postgres',
      TUBEROSA_CACHE: 'redis',
      TUBEROSA_MODEL_PROVIDER: 'local',
      DATABASE_URL: `postgres://tuberosa:tuberosa@127.0.0.1:${options.postgresPort}/tuberosa`,
      REDIS_URL: `redis://127.0.0.1:${options.redisPort}`,
    },
  };
}

export type JsonMergeResult =
  | { status: 'written'; contents: string }
  | { status: 'exists' }
  | { status: 'invalid'; error: string };

export function mergeMcpJson(
  existing: string | undefined,
  entry: McpServerEntry,
  force: boolean,
): JsonMergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      return { status: 'invalid', error: (error as Error).message };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', error: 'top-level JSON value is not an object' };
    }
    doc = parsed as Record<string, unknown>;
  }
  const rawServers = doc.mcpServers;
  const servers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  if (servers.tuberosa !== undefined && !force) {
    return { status: 'exists' };
  }
  servers.tuberosa = entry;
  doc.mcpServers = servers;
  return { status: 'written', contents: `${JSON.stringify(doc, null, 2)}\n` };
}

export function renderTomlSection(entry: McpServerEntry): string {
  const envLines = Object.entries(entry.env)
    .map(([key, value]) => `${key} = "${value}"`)
    .join('\n');
  return [
    '',
    '# added by tuberosa mcp install',
    '[mcp_servers.tuberosa]',
    `command = "${entry.command}"`,
    `args = [${entry.args.map((a) => `"${a}"`).join(', ')}]`,
    '',
    '[mcp_servers.tuberosa.env]',
    envLines,
    '',
  ].join('\n');
}

export function tomlHasTuberosaEntry(existing: string): boolean {
  return /^\s*\[mcp_servers\.tuberosa\]/m.test(existing);
}
