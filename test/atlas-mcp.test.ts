import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import type { AppServices } from '../src/app.js';

async function atlasServices(): Promise<AppServices> {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a/x.ts', contentHash: 'h', status: 'tracked' });
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-mcp-'));
  // The atlas tool + resource paths only touch services.store and services.config.
  return { store, config: { atlasDir, defaultCwd: process.cwd() } } as unknown as AppServices;
}

function req(method: string, params: unknown) {
  return { jsonrpc: '2.0', id: 1, method, params } as Parameters<typeof handleMcpRequest>[1];
}

test('tuberosa_get_atlas tool returns all five files', async () => {
  const services = await atlasServices();
  const res = (await handleMcpRequest(services, req('tools/call', {
    name: 'tuberosa_get_atlas',
    arguments: { project: 'p' },
  }))) as { structuredContent: { files: { name: string }[] } };
  assert.equal(res.structuredContent.files.length, 5);
  assert.deepEqual(
    res.structuredContent.files.map((f) => f.name).sort(),
    ['commands.md', 'flows.md', 'open-gaps.md', 'project-map.md', 'risks.md'],
  );
});

test('tuberosa_get_atlas tool returns a single named file', async () => {
  const services = await atlasServices();
  const res = (await handleMcpRequest(services, req('tools/call', {
    name: 'tuberosa_get_atlas',
    arguments: { project: 'p', file: 'project-map.md' },
  }))) as { structuredContent: { files: { name: string }[] } };
  assert.equal(res.structuredContent.files.length, 1);
  assert.equal(res.structuredContent.files[0].name, 'project-map.md');
});

test('atlas resource reads project-map.md as markdown', async () => {
  const services = await atlasServices();
  const res = (await handleMcpRequest(services, req('resources/read', {
    uri: 'tuberosa://atlas/p/project-map.md',
  }))) as { contents: { uri: string; mimeType: string; text: string }[] };
  assert.equal(res.contents[0].mimeType, 'text/markdown');
  assert.match(res.contents[0].text, /# Project Map/);
});
