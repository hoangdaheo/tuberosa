import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionService } from '../src/agent-session/service.js';
import type { AppServices } from '../src/app.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { CurationService } from '../src/curation/service.js';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { HashModelProvider } from '../src/model/provider.js';
import { OperationsService } from '../src/operations/service.js';
import { SessionReplayService } from '../src/operations/session-replay.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  httpHost: '127.0.0.1',
  requireApiKeyForNonLoopback: false,
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  exportBaseDir: '.tuberosa/test-exports',
} as AppConfig;

async function seedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-repo-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo',
      scripts: {
        build: 'tsc -p tsconfig.json',
        test: 'node --test',
        lint: 'eslint .',
        dev: 'pnpm run watch',
      },
    }),
    'utf8',
  );
  await writeFile(
    join(dir, 'README.md'),
    '# Demo\n\nA demo project.\n\n## Commands\n\n```bash\npnpm test\n```\n',
    'utf8',
  );
  await writeFile(join(dir, 'CONTRIBUTING.md'), '# Contributing\n\nRun tests before pushing.\n', 'utf8');
  return dir;
}

test('bootstrapHandbook returns deterministic extraction inputs + a review-gated instruction', async () => {
  const store = new MemoryKnowledgeStore();
  const repoPath = await seedRepo();
  const project = 'bootstrap-svc';
  try {
    const svc = new CurationService(store);
    const result = await svc.bootstrapHandbook({ project, repoPath, generatedAt: '2026-05-29T00:00:00.000Z' });

    // Shape of extraction.
    ok(Array.isArray(result.extraction.detectedTech));
    ok(Array.isArray(result.extraction.areas));
    equal(typeof result.extraction.scripts, 'object');
    ok(Array.isArray(result.extraction.docExcerpts));
    ok(Array.isArray(result.extraction.recurringHints));

    // Tech detection picked up tsc + pnpm.
    ok(result.extraction.detectedTech.includes('typescript'));
    ok(result.extraction.detectedTech.includes('pnpm'));

    // Docs were read best-effort.
    ok(result.extraction.docExcerpts.some((d) => d.source === 'README.md'));
    ok(result.extraction.docExcerpts.some((d) => d.source === 'CONTRIBUTING.md'));

    // Instruction wording.
    ok(result.instruction.includes('tuberosa_reflect'));
    ok(result.instruction.includes('convention'));
    ok(result.instruction.includes('curationSource'));
    ok(result.instruction.includes('bootstrap'));
    ok(/review|pending|confirm/i.test(result.instruction));

    // Determinism: same generatedAt -> deep-equal output.
    const again = await svc.bootstrapHandbook({ project, repoPath, generatedAt: '2026-05-29T00:00:00.000Z' });
    deepEqual(again, result);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

function createTestServices(): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, { safety });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const sessionReplay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(store, retrieval, reflection, models, sessionReplay, config);
  const operations = new OperationsService(store, ingestion);
  const errorLogs = new ErrorLogService({ rootDir: config.errorLogDir, safety });
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const maintenance = new MaintenanceService(store);
  const curation = new CurationService(store);

  return {
    config,
    store,
    cache,
    models,
    safety,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    errorLogs,
    errorLogInsights,
    maintenance,
    curation,
    async close() {
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}

test('tuberosa_bootstrap_handbook is registered and returns extraction + instruction', async () => {
  const services = createTestServices();
  const repoPath = await seedRepo();
  try {
    const project = 'bootstrap-mcp';

    const toolsList = await handleMcpRequest(services, { method: 'tools/list' }) as { tools: Array<{ name: string }> };
    ok(Array.isArray(toolsList.tools));
    const toolNames = toolsList.tools.map((tool) => tool.name);
    ok(toolNames.includes('tuberosa_bootstrap_handbook'));

    const response = await handleMcpRequest(services, {
      method: 'tools/call',
      params: { name: 'tuberosa_bootstrap_handbook', arguments: { project, repoPath } },
    }) as { structuredContent?: { extraction?: Record<string, unknown>; instruction?: string } };

    const extraction = response.structuredContent?.extraction;
    ok(extraction);
    // Prove the JSON round-trip is lossless on the value parsed from the MCP response.
    ok(Array.isArray(extraction?.detectedTech));
    ok(Array.isArray(extraction?.areas));
    ok(Array.isArray(extraction?.recurringHints));
    ok(Array.isArray(extraction?.docExcerpts));
    equal(typeof extraction?.scripts, 'object');
    ok(extraction?.scripts !== null && !Array.isArray(extraction?.scripts));

    equal(typeof response.structuredContent?.instruction, 'string');
    ok((response.structuredContent?.instruction ?? '').includes('tuberosa_reflect'));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await services.close();
  }
});
