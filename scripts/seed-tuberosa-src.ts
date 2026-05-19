import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createAppServices } from '../src/app.js';
import type { IngestFileInput } from '../src/ingest/service.js';
import type { LabelInput } from '../src/types.js';

const PROJECT = 'tuberosa';
const ROOT = new URL('..', import.meta.url).pathname;

interface DirConfig {
  dir: string;
  domain: string;
}

const SOURCE_DIRS: DirConfig[] = [
  { dir: 'src/retrieval', domain: 'retrieval' },
  { dir: 'src/model', domain: 'model-provider' },
  { dir: 'src/agent-session', domain: 'agent-session' },
  { dir: 'src/ingest', domain: 'ingestion' },
  { dir: 'src/storage', domain: 'storage' },
  { dir: 'src/operations', domain: 'operations' },
  { dir: 'src/mcp', domain: 'mcp' },
];

async function collectSourceFiles(): Promise<IngestFileInput[]> {
  const inputs: IngestFileInput[] = [];

  for (const { dir, domain } of SOURCE_DIRS) {
    const absDir = join(ROOT, dir);
    let entries: string[];
    try {
      entries = await readdir(absDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const absPath = join(absDir, entry);
      const content = await readFile(absPath, 'utf8');
      const labels: LabelInput[] = [
        { type: 'domain', value: domain, weight: 1 },
        { type: 'file', value: relative(ROOT, absPath), weight: 1 },
      ];
      inputs.push({
        project: PROJECT,
        path: relative(ROOT, absPath),
        content,
        itemType: 'code_ref',
        mode: 'document',
        labels,
      });
    }
  }

  return inputs;
}

async function collectDocFiles(): Promise<IngestFileInput[]> {
  const docsDir = join(ROOT, 'docs');
  let entries: string[];
  try {
    entries = await readdir(docsDir);
  } catch {
    return [];
  }

  const inputs: IngestFileInput[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const absPath = join(docsDir, entry);
    const content = await readFile(absPath, 'utf8');
    inputs.push({
      project: PROJECT,
      path: relative(ROOT, absPath),
      content,
      itemType: 'wiki',
      mode: 'atomic',
      labels: [{ type: 'domain', value: 'documentation', weight: 1 }],
    });
  }

  return inputs;
}

async function main(): Promise<void> {
  const services = await createAppServices();
  try {
    const sourceFiles = await collectSourceFiles();
    const docFiles = await collectDocFiles();
    const allFiles = [...sourceFiles, ...docFiles];

    console.log(`Ingesting ${allFiles.length} files for project '${PROJECT}'...`);

    const stored = await services.ingestion.ingestFiles(PROJECT, allFiles);

    console.log(JSON.stringify({
      project: PROJECT,
      ingested: stored.length,
      items: stored.map((item) => ({
        id: item.id,
        title: item.title,
        itemType: item.itemType,
        sourceUri: item.sourceUri,
      })),
    }, null, 2));
  } finally {
    await services.close();
  }
}

await main();
