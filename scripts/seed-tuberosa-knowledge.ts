import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createAppServices } from '../src/app.js';
import type { IngestFileInput } from '../src/ingest/service.js';
import type { LabelInput } from '../src/types.js';

const PROJECT = 'tuberosa';
const ROOT = new URL('..', import.meta.url).pathname;

const SRC_DOMAINS: Record<string, string> = {
  'src/retrieval': 'retrieval',
  'src/model': 'model-provider',
  'src/agent-session': 'agent-session',
  'src/ingest': 'ingestion',
  'src/storage': 'storage',
  'src/operations': 'operations',
  'src/mcp': 'mcp',
  'src/http': 'http-api',
  'src/security': 'security',
  'src/error-log': 'error-log',
  'src/reflection': 'reflection',
  'src/maintenance': 'maintenance',
  'src/evaluation': 'evaluation',
  'src/workbench': 'workbench',
  'src/relations': 'relations',
  'src/util': 'util',
};

const ROOT_SRC_FILES: Record<string, string> = {
  'src/app.ts': 'bootstrap',
  'src/cache.ts': 'cache',
  'src/config.ts': 'config',
  'src/errors.ts': 'errors',
  'src/index.ts': 'http-entry',
  'src/mcp-stdio.ts': 'mcp-entry',
  'src/types.ts': 'types',
  'src/validation.ts': 'validation',
  'src/worker.ts': 'worker',
};

const ROOT_DOCS: Record<string, string> = {
  'README.md': 'documentation',
  'AGENTS.md': 'documentation',
  'CLAUDE.md': 'documentation',
};

async function walk(dir: string, predicate: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    const st = await stat(abs);
    if (st.isDirectory()) {
      out.push(...(await walk(abs, predicate)));
    } else if (predicate(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function isCodeFile(path: string): boolean {
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return false;
  if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) return false;
  return true;
}

async function collectSourceFiles(): Promise<IngestFileInput[]> {
  const inputs: IngestFileInput[] = [];

  for (const [dir, domain] of Object.entries(SRC_DOMAINS)) {
    const absDir = join(ROOT, dir);
    const files = await walk(absDir, isCodeFile);
    for (const absPath of files) {
      const rel = relative(ROOT, absPath);
      const content = await readFile(absPath, 'utf8');
      const labels: LabelInput[] = [
        { type: 'domain', value: domain, weight: 1 },
        { type: 'file', value: rel, weight: 1 },
      ];
      inputs.push({
        project: PROJECT,
        path: rel,
        content,
        itemType: 'code_ref',
        mode: 'document',
        labels,
      });
    }
  }

  for (const [rel, domain] of Object.entries(ROOT_SRC_FILES)) {
    const absPath = join(ROOT, rel);
    try {
      const content = await readFile(absPath, 'utf8');
      inputs.push({
        project: PROJECT,
        path: rel,
        content,
        itemType: 'code_ref',
        mode: 'document',
        labels: [
          { type: 'domain', value: domain, weight: 1 },
          { type: 'file', value: rel, weight: 1 },
        ],
      });
    } catch {
      /* skip missing */
    }
  }

  return inputs;
}

async function collectDocFiles(): Promise<IngestFileInput[]> {
  const inputs: IngestFileInput[] = [];

  for (const [rel, domain] of Object.entries(ROOT_DOCS)) {
    const absPath = join(ROOT, rel);
    try {
      const content = await readFile(absPath, 'utf8');
      inputs.push({
        project: PROJECT,
        path: rel,
        content,
        itemType: 'wiki',
        mode: 'atomic',
        labels: [
          { type: 'domain', value: domain, weight: 1 },
          { type: 'file', value: rel, weight: 1 },
        ],
      });
    } catch {
      /* skip */
    }
  }

  const docsDir = join(ROOT, 'docs');
  const docFiles = await walk(docsDir, (p) => p.endsWith('.md'));
  for (const absPath of docFiles) {
    const rel = relative(ROOT, absPath);
    const content = await readFile(absPath, 'utf8');
    const segments = rel.split(sep);
    const subdir = segments.length > 2 ? segments[1] : 'general';
    inputs.push({
      project: PROJECT,
      path: rel,
      content,
      itemType: 'wiki',
      mode: 'atomic',
      labels: [
        { type: 'domain', value: `docs/${subdir}`, weight: 1 },
        { type: 'file', value: rel, weight: 1 },
      ],
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

    console.log(`Ingesting ${allFiles.length} files for project '${PROJECT}' (${sourceFiles.length} code, ${docFiles.length} docs)...`);

    const stored: Array<{ id: string; itemType: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const file of allFiles) {
      try {
        const result = await services.ingestion.ingestFiles(PROJECT, [file]);
        for (const item of result) stored.push({ id: item.id, itemType: item.itemType });
      } catch (err) {
        const reason = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
        skipped.push({ path: file.path, reason });
      }
    }

    const byType = stored.reduce<Record<string, number>>((acc, item) => {
      acc[item.itemType] = (acc[item.itemType] ?? 0) + 1;
      return acc;
    }, {});

    console.log(JSON.stringify({
      project: PROJECT,
      ingested: stored.length,
      skipped,
      byType,
    }, null, 2));
  } finally {
    await services.close();
  }
}

await main();
