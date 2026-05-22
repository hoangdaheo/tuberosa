import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { MarkdownAtomizer } from '../src/ingest/document-atomizer.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
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
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

const SAMPLE_DOC = `# Phase 4 Plan

Introduction text that mentions overall scope but not the specific subsection topic.

## Reranker Policy

Some background prose about how the reranker is configured.

### Score Weighting

The composite combines three contributors via a weighted sum. The weights are stable across releases
unless a calibration script writes a new patch. Floor and ceiling are clamped to keep the result in [0, 1].

### Threshold Buckets

Buckets divide the composite into status tiers. The first tier is for high-trust evidence; the
last tier is for fallback / unknown.

## Confidence Probe

A small unrelated section about probes that should not match the score-weighting query.
`;

test('Phase 4: MarkdownAtomizer emits a breadcrumb on every atom', () => {
  const atomizer = new MarkdownAtomizer();
  const atoms = atomizer.atomize({ path: 'docs/phase4.md', content: SAMPLE_DOC });

  ok(atoms.length >= 3, `expected at least 3 atoms; got ${atoms.length}`);

  for (const atom of atoms) {
    const breadcrumb = (atom as { breadcrumb?: string }).breadcrumb;
    ok(typeof breadcrumb === 'string' && breadcrumb.length > 0, `atom missing breadcrumb: ${JSON.stringify(atom.sectionPath)}`);
    // Breadcrumbs MUST start with the source path so cross-doc queries can land on the right file.
    ok(
      breadcrumb.startsWith('docs/phase4.md'),
      `breadcrumb should start with the source path; got ${JSON.stringify(breadcrumb)}`,
    );
  }

  const weighting = atoms.find((atom) => atom.sectionSlug.includes('score-weighting'));
  ok(weighting, 'score-weighting atom should be emitted');
  const weightingBreadcrumb = (weighting as { breadcrumb?: string }).breadcrumb ?? '';
  ok(
    weightingBreadcrumb.toLowerCase().includes('phase 4 plan'),
    `score-weighting breadcrumb should carry the H1 'Phase 4 Plan'; got ${JSON.stringify(weightingBreadcrumb)}`,
  );
  ok(
    weightingBreadcrumb.toLowerCase().includes('reranker policy'),
    `score-weighting breadcrumb should carry the H2 'Reranker Policy'; got ${JSON.stringify(weightingBreadcrumb)}`,
  );
});

test('Phase 4: parent-topic query retrieves the right atom via breadcrumb (not via body)', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const provider = new HashModelProvider(config.embeddingDimensions);
  const ingestion = new IngestionService(store, provider);
  const retrieval = new RetrievalService(store, cache, provider, config);

  await ingestion.ingestFiles(
    'phase4',
    [{ project: 'phase4', path: 'docs/phase4.md', content: SAMPLE_DOC, itemType: 'wiki' }],
    { mode: 'atomic' },
  );

  // Query uses the parent-doc topic words — "Phase 4 Plan" + "Reranker Policy" —
  // which the atom body of "Score Weighting" does NOT repeat. Without breadcrumbs the
  // body alone would not surface this atom; with breadcrumbs the contextualContent
  // does, and lexical+vector both see it.
  const pack = await retrieval.searchContext({
    prompt: 'In the Phase 4 Plan reranker policy, how is the composite score weighting computed?',
    project: 'phase4',
    bypassCache: true,
  });

  const flatItems = (pack.sections ?? []).flatMap((section) => section.items);
  const weighting = flatItems.find((item) => {
    const slug = (item.metadata?.sectionSlug as string | undefined) ?? '';
    return slug.includes('score-weighting');
  });

  ok(
    weighting,
    `score-weighting atom must surface from the parent-topic query; got ${JSON.stringify(flatItems.map((item) => item.title))}`,
  );

  // The atom's stored content must NOT contain the breadcrumb — content stays clean.
  const content = (weighting as { content?: string }).content ?? '';
  ok(
    !content.toLowerCase().includes('breadcrumb:'),
    'atom content must not carry a literal "Breadcrumb:" line — that lives in contextualContent only',
  );
  // The atom's contextualContent MUST carry the breadcrumb in the spec format so embedding + FTS pick it up.
  const contextualContent = (weighting as { contextualContent?: string }).contextualContent ?? '';
  const expectedBreadcrumb = 'docs/phase4.md > Phase 4 Plan > Reranker Policy > Score Weighting';
  ok(
    contextualContent.includes(expectedBreadcrumb),
    `contextualContent should carry the spec-format breadcrumb '${expectedBreadcrumb}'; got first 400 chars: ${contextualContent.slice(0, 400)}`,
  );
});
