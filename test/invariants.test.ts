import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { doesNotThrow, equal, match, ok } from 'node:assert/strict';

test('CLAUDE.md invariant: all migrations agree on one embedding dimension that matches the config default', async () => {
  // Read every .sql file in the migrations/ directory.
  const dir = 'migrations';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  ok(files.length >= 1, 'expected at least one .sql file in migrations/');

  // Collect every vector(N) occurrence across all migration files.
  // Strip `--` line comments first so prose like "-- vector(1536)" cannot
  // trip the scan — only real declarations count.
  const found: Array<{ file: string; dim: number }> = [];
  for (const file of files) {
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    const withoutComments = sql.replace(/--[^\n]*/g, '');
    const hits = [...withoutComments.matchAll(/vector\((\d+)\)/g)];
    for (const m of hits) {
      found.push({ file, dim: Number(m[1]) });
    }
  }

  ok(found.length >= 1, 'expected at least one vector(N) declaration across all migrations');
  const sqlDims = new Set(found.map((f) => f.dim));
  const byFile = [...new Set(found.map((f) => `${f.file}=${f.dim}`))].join(', ');
  equal(sqlDims.size, 1, `all vector(N) declarations across all migrations must agree on one dimension; dimension mismatch: ${byFile}`);
  const declared = found[0]!.dim;

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();
  equal(config.model.embeddingDimensions, declared,
    `EMBEDDING_DIMENSIONS=${config.model.embeddingDimensions} must equal vector(${declared}) across all migrations`);
});

test('CLAUDE.md invariant: mcp-stdio writes only JSON-RPC frames to stdout', async () => {
  const child = spawn('node', ['--import', 'tsx', 'src/mcp-stdio.ts'], {
    env: {
      ...process.env,
      TUBEROSA_STORE: 'memory',
      TUBEROSA_CACHE: 'memory',
      TUBEROSA_MODEL_PROVIDER: 'hash',
      TUBEROSA_PHYSICAL_MIRROR_ENABLED: 'false',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  await new Promise((r) => setTimeout(r, 400));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'probe-1', method: 'tools/list' })}\n`);

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (stdout.includes('"id":"probe-1"')) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  child.stdin.end();
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => { child.kill(); resolve(); }, 1500);
  });

  ok(stdout.length > 0, `expected at least one stdout frame; stderr=${stderr}`);
  const frames = parseStdoutFrames(stdout);
  ok(frames.length >= 1, `expected at least one parsed JSON-RPC frame; raw stdout=${JSON.stringify(stdout.slice(0, 200))}`);
  for (const frame of frames) {
    doesNotThrow(() => JSON.parse(frame), `non-JSON on stdout: ${frame.slice(0, 80)}`);
    const parsed = JSON.parse(frame);
    match(JSON.stringify(parsed), /"jsonrpc":"2\.0"/, `frame missing jsonrpc=2.0: ${frame.slice(0, 80)}`);
  }
});

/**
 * mcp-stdio supports two framings:
 *   - line framing: one JSON object per `\n`-terminated line
 *   - Content-Length framing: `Content-Length: N\r\n\r\n<body>`
 * Split the captured stdout into individual JSON bodies regardless of framing.
 */
function parseStdoutFrames(stdout: string): string[] {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    if (stdout.startsWith('Content-Length:', cursor)) {
      const headerEnd = stdout.indexOf('\r\n\r\n', cursor);
      if (headerEnd === -1) break;
      const header = stdout.slice(cursor, headerEnd);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { cursor = headerEnd + 4; continue; }
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      const body = stdout.slice(bodyStart, bodyStart + length);
      if (body.trim()) out.push(body);
      cursor = bodyStart + length;
    } else {
      const nl = stdout.indexOf('\n', cursor);
      const end = nl === -1 ? stdout.length : nl;
      const line = stdout.slice(cursor, end).trim();
      if (line) out.push(line);
      cursor = end + 1;
    }
  }
  return out;
}
