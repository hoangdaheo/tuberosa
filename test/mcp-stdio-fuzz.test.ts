import { spawn } from 'node:child_process';
import test from 'node:test';
import { match } from 'node:assert/strict';

const SERVER_ENV = {
  ...process.env,
  TUBEROSA_STORE: 'memory',
  TUBEROSA_CACHE: 'memory',
  TUBEROSA_MODEL_PROVIDER: 'hash',
  // disable physical mirror so the child doesn't write into the working tree
  TUBEROSA_PHYSICAL_MIRROR_ENABLED: 'false',
};

test('mcp-stdio survives a malformed JSON frame and answers the next valid frame', async () => {
  const child = spawn('node', ['--import', 'tsx', 'src/mcp-stdio.ts'], { env: SERVER_ENV });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  await new Promise((r) => setTimeout(r, 400));

  child.stdin.write('{not valid json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'probe-1', method: 'tools/list' })}\n`);

  // Wait for both replies (parse error + tools/list).
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (stdout.includes('-32700') && stdout.includes('"id":"probe-1"')) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  child.stdin.end();
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => { child.kill(); resolve(); }, 1500);
  });

  match(stdout, /-32700/, `expected -32700 Parse error frame in stdout. stderr=${stderr}`);
  match(stdout, /"id":"probe-1"/, `expected tools/list reply with id=probe-1 in stdout. stderr=${stderr}`);
});
