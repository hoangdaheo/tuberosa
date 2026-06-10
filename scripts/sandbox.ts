import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { generateSandboxFixture, type SandboxFixture, type SandboxKnowledge, type SandboxTier } from '../eval/sandbox/generator.js';
import { buildSandboxPrompts, type SandboxPrompt } from '../eval/sandbox/prompts.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type {
  CandidateSource,
  ContextPack,
  FilterEvent,
  ScoreBreakdown,
} from '../src/types.js';

type AblationSource = CandidateSource | 'none';

interface CliOptions {
  reportPath: string;
  thresholdsPath: string;
  seed: number;
  ablate: boolean;
  failUnder: boolean;
  json: boolean;
  help: boolean;
}

interface SandboxThresholds {
  description?: string;
  minHitRate: number;
  minMRR: number;
  maxNoiseRate: number;
  minStaleSuppressionRate: number;
  minDuplicateSuppressionRate: number;
  minAdversarialBlockRate: number;
  maxItemTypeCatchAllRate: number;
  minItemTypeDiagonalRate?: number;
  minLabelDiagonalRate?: number;
  minPerFilterPrecision?: Record<string, number>;
}

interface SandboxRunMetrics {
  totalPrompts: number;
  hits: number;
  hitRate: number;
  mrr: number;
  staleSuppressed: number;
  staleExpected: number;
  staleSuppressionRate: number;
  duplicateSuppressed: number;
  duplicateExpected: number;
  duplicateSuppressionRate: number;
  adversarialBlocked: number;
  adversarialExpected: number;
  adversarialBlockRate: number;
  noiseHits: number;
  noiseExpected: number;
  noiseRate: number;
  itemTypeCatchAllRate: number;
  perItemType: Record<string, { hits: number; total: number; correctlyHit: number; precision: number; recall: number }>;
  perTier: Record<string, { selected: number; suppressed: number; expectedSelected: number; expectedSuppressed: number }>;
  perSourceContribution: Record<CandidateSource, number>;
  perFilter: Record<string, { triggered: number; correct: number; precision: number }>;
  latency: { p50: number; p95: number; max: number; samples: number };
  /** Phase 3 — diagonal hit rate for `expectedItemTypes` ∩ retrieved itemType. */
  itemTypeDiagonalRate: number;
  /**
   * Phase 3 — confusion of selected vs. expected itemTypes.
   * `confusion[expected][actual] = count`. expected can also be `'<unspecified>'`.
   */
  itemTypeConfusion: Record<string, Record<string, number>>;
  /** Phase 3 — same idea, restricted to label types tested in prompts (e.g., symbol/file). */
  labelDiagonalRate: number;
  labelConfusion: Record<string, Record<string, number>>;
}

interface AblationRow {
  disabled: AblationSource;
  hitRate: number;
  mrr: number;
}

interface SandboxRunResult {
  fixtureSeed: number;
  knowledgeCount: number;
  promptCount: number;
  thresholds: SandboxThresholds;
  metrics: SandboxRunMetrics;
  ablation?: AblationRow[];
  failures: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = generateSandboxFixture(options.seed);
  const prompts = buildSandboxPrompts(fixture).prompts;
  const thresholds = await loadThresholds(options.thresholdsPath);

  const baselineMetrics = await runSandboxRun(fixture, prompts, null);
  let ablation: AblationRow[] | undefined;
  if (options.ablate) {
    ablation = await runAblation(fixture, prompts);
  }

  const failures = evaluateThresholds(baselineMetrics, thresholds);
  const result: SandboxRunResult = {
    fixtureSeed: fixture.seed,
    knowledgeCount: fixture.knowledge.length,
    promptCount: prompts.length,
    thresholds,
    metrics: baselineMetrics,
    ablation,
    failures,
  };

  await writeReport(options.reportPath, result, fixture);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  if (options.failUnder && failures.length > 0) {
    process.exitCode = 1;
  }
}

async function runSandboxRun(
  fixture: SandboxFixture,
  prompts: SandboxPrompt[],
  disabledSource: AblationSource | null,
): Promise<SandboxRunMetrics> {
  const { ingestion, retrieval, store, cache } = createServices();
  const ingestEvents: FilterEvent[] = [];
  try {
    const idMap = await ingestFixture(fixture, ingestion, store, ingestEvents);
    return await runPrompts(prompts, idMap, fixture, retrieval, disabledSource, ingestEvents);
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

async function runAblation(fixture: SandboxFixture, prompts: SandboxPrompt[]): Promise<AblationRow[]> {
  const sources: AblationSource[] = ['lexical', 'vector', 'metadata', 'memory', 'graph'];
  const rows: AblationRow[] = [];
  for (const disabled of sources) {
    const metrics = await runSandboxRun(fixture, prompts, disabled);
    rows.push({ disabled, hitRate: metrics.hitRate, mrr: metrics.mrr });
  }
  return rows;
}

function createServices() {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(SANDBOX_CONFIG.model.embeddingDimensions);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, SANDBOX_CONFIG);
  return { ingestion, retrieval, store, cache };
}

async function ingestFixture(
  fixture: SandboxFixture,
  ingestion: IngestionService,
  store: MemoryKnowledgeStore,
  ingestEvents?: FilterEvent[],
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  for (const knowledge of fixture.knowledge) {
    try {
      const stored = await ingestion.ingestKnowledge({
        project: knowledge.project,
        sourceType: knowledge.sourceType,
        sourceUri: knowledge.sourceUri,
        sourceTitle: knowledge.sourceTitle,
        itemType: knowledge.itemType,
        title: knowledge.title,
        summary: knowledge.summary,
        content: knowledge.content,
        trustLevel: knowledge.trustLevel,
        labels: knowledge.labels,
        references: knowledge.references,
        freshnessAt: knowledge.freshnessAt,
        metadata: knowledge.metadata,
      });
      idMap.set(knowledge.sandboxId, stored.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isDuplicate = message.includes('duplicate') || /duplicate/i.test(error instanceof Error ? error.name : '');
      ingestEvents?.push({
        filter: isDuplicate ? 'duplicate' : 'safety_block_ingest',
        action: 'excluded',
        reason: `Ingestion blocked sandbox=${knowledge.sandboxId} tier=${knowledge.tier}: ${message}`,
        metadata: { sandboxId: knowledge.sandboxId, tier: knowledge.tier, project: knowledge.project },
      });
    }
  }

  for (const relation of fixture.relations) {
    const fromId = idMap.get(relation.fromSandboxId);
    const toId = idMap.get(relation.toSandboxId);
    if (!fromId || !toId) {
      continue;
    }
    await store.createKnowledgeRelation({
      fromKnowledgeId: fromId,
      relationType: relation.relationType,
      targetKind: 'knowledge',
      targetKnowledgeId: toId,
      confidence: relation.confidence,
      inferred: false,
    });
  }

  return idMap;
}

async function runPrompts(
  prompts: SandboxPrompt[],
  idMap: Map<string, string>,
  fixture: SandboxFixture,
  retrieval: RetrievalService,
  disabledSource: AblationSource | null,
  ingestEvents: FilterEvent[] = [],
): Promise<SandboxRunMetrics> {
  const reverse = new Map<string, SandboxKnowledge>();
  for (const knowledge of fixture.knowledge) {
    const storedId = idMap.get(knowledge.sandboxId);
    if (storedId) {
      reverse.set(storedId, knowledge);
    }
  }

  const metrics = blankMetrics();
  const latencies: number[] = [];
  const filterPrecisionTracker = new Map<string, { triggered: number; correct: number }>();
  const itemTypeCatchAllCount = { selected: 0, totalSelected: 0 };
  const itemTypeConfusionCount = { diagonal: 0, total: 0 };
  const labelConfusionCount = { diagonal: 0, total: 0 };
  const ingestionBlockedSandboxIds = new Set<string>();

  const duplicateBlockedSandboxIds = new Set<string>();
  for (const event of ingestEvents) {
    const tracker = filterPrecisionTracker.get(event.filter) ?? { triggered: 0, correct: 0 };
    tracker.triggered += 1;
    const sandboxId = (event.metadata?.sandboxId as string | undefined) ?? '';
    const tier = (event.metadata?.tier as string | undefined) ?? '';
    if (event.filter === 'duplicate' && tier === 'D') {
      tracker.correct += 1;
      duplicateBlockedSandboxIds.add(sandboxId);
    }
    if (event.filter === 'safety_block_ingest' && tier === 'E') {
      tracker.correct += 1;
      ingestionBlockedSandboxIds.add(sandboxId);
    }
    filterPrecisionTracker.set(event.filter, tracker);
  }

  for (const prompt of prompts) {
    metrics.totalPrompts += 1;
    const started = Date.now();
    const pack = await retrieval.searchContext({
      prompt: prompt.prompt,
      project: prompt.project,
      files: prompt.files,
      symbols: prompt.symbols,
      errors: prompt.errors,
      taskType: prompt.taskType,
      noiseTolerance: 'strict',
      contextMode: 'compact',
      debug: true,
      disabledSources: disabledSource && disabledSource !== 'none' ? [disabledSource as CandidateSource] : undefined,
    });
    const elapsed = Date.now() - started;
    latencies.push(elapsed);

    const trace = pack.debug;
    const selectedKnowledgeIds = collectSelectedKnowledgeIds(pack);
    const selectedSandboxIds = mapToSandboxIds(selectedKnowledgeIds, reverse);
    const selectedSet = new Set(selectedSandboxIds);

    const expectedSelected = new Set(prompt.expectedSelectedSandboxIds);
    const forbidden = new Set(prompt.forbiddenSandboxIds);
    const expectedFiltered = new Set(prompt.expectedNoiseFilteredSandboxIds);

    // Hits & MRR
    let firstHitRank = 0;
    let hit = expectedSelected.size === 0; // tolerant when no positive expectations
    for (let index = 0; index < selectedSandboxIds.length; index += 1) {
      if (expectedSelected.has(selectedSandboxIds[index]!)) {
        hit = true;
        firstHitRank = index + 1;
        break;
      }
    }
    if (hit) {
      metrics.hits += 1;
      if (firstHitRank > 0) {
        metrics.mrr += 1 / firstHitRank;
      }
    }

    // Noise / forbidden hits + itemType / label confusion bookkeeping
    const expectedItemTypeSet = new Set(prompt.expectedItemTypes ?? []);
    const expectedLabelSet = new Set((prompt.expectedLabels ?? []).map((label) => `${label.type}:${label.value.toLowerCase()}`));
    for (const sandboxId of selectedSandboxIds) {
      if (forbidden.has(sandboxId)) {
        metrics.noiseHits += 1;
      }
      const knowledge = sandboxIdToKnowledge(sandboxId, fixture);
      if (!knowledge) continue;
      metrics.perTier[knowledge.tier]!.selected += 1;
      const itemType = knowledge.itemType;
      const perType = metrics.perItemType[itemType] ?? { hits: 0, total: 0, correctlyHit: 0, precision: 0, recall: 0 };
      perType.hits += 1;
      if (expectedSelected.has(sandboxId)) {
        perType.correctlyHit += 1;
      }
      metrics.perItemType[itemType] = perType;
      itemTypeCatchAllCount.totalSelected += 1;
      if (itemType === 'memory') {
        itemTypeCatchAllCount.selected += 1;
      }

      const expectedKey = expectedItemTypeSet.size === 0
        ? '<unspecified>'
        : (expectedItemTypeSet.has(itemType) ? itemType : `expected:${[...expectedItemTypeSet].join('|')}`);
      const confusionRow = metrics.itemTypeConfusion[expectedKey] ?? {};
      confusionRow[itemType] = (confusionRow[itemType] ?? 0) + 1;
      metrics.itemTypeConfusion[expectedKey] = confusionRow;
      itemTypeConfusionCount.total += 1;
      if (expectedItemTypeSet.size === 0 || expectedItemTypeSet.has(itemType)) {
        itemTypeConfusionCount.diagonal += 1;
      }

      for (const label of knowledge.labels ?? []) {
        const key = `${label.type}:${label.value.toLowerCase()}`;
        const expectedLabel = expectedLabelSet.has(key) ? key : '<other>';
        const row = metrics.labelConfusion[expectedLabel] ?? {};
        row[key] = (row[key] ?? 0) + 1;
        metrics.labelConfusion[expectedLabel] = row;
        labelConfusionCount.total += 1;
        if (expectedLabelSet.has(key)) {
          labelConfusionCount.diagonal += 1;
        }
      }
    }

    metrics.noiseExpected += forbidden.size;

    // Expected suppression counts
    for (const sandboxId of expectedFiltered) {
      const knowledge = sandboxIdToKnowledge(sandboxId, fixture);
      if (!knowledge) continue;
      if (knowledge.tier === 'C') metrics.staleExpected += 1;
      if (knowledge.tier === 'D') metrics.duplicateExpected += 1;
      if (knowledge.tier === 'E') metrics.adversarialExpected += 1;

      metrics.perTier[knowledge.tier]!.expectedSuppressed += 1;
      const blockedAtIngest = ingestionBlockedSandboxIds.has(sandboxId) || duplicateBlockedSandboxIds.has(sandboxId);
      const wasSuppressed = blockedAtIngest || !selectedSet.has(sandboxId);
      if (wasSuppressed) {
        metrics.perTier[knowledge.tier]!.suppressed += 1;
        if (knowledge.tier === 'C') metrics.staleSuppressed += 1;
        if (knowledge.tier === 'D') metrics.duplicateSuppressed += 1;
        if (knowledge.tier === 'E') metrics.adversarialBlocked += 1;
      }
    }

    for (const sandboxId of expectedSelected) {
      const knowledge = sandboxIdToKnowledge(sandboxId, fixture);
      if (!knowledge) continue;
      metrics.perTier[knowledge.tier]!.expectedSelected += 1;
      const perType = metrics.perItemType[knowledge.itemType] ?? { hits: 0, total: 0, correctlyHit: 0, precision: 0, recall: 0 };
      perType.total += 1;
      metrics.perItemType[knowledge.itemType] = perType;
    }

    // Per-source contribution
    if (trace?.fusionBreakdown) {
      const breakdownById = new Map<string, ScoreBreakdown>();
      for (const entry of trace.fusionBreakdown) {
        breakdownById.set(entry.knowledgeId, entry);
      }
      for (const expectedId of expectedSelected) {
        const storedId = idMap.get(expectedId);
        if (!storedId) continue;
        const entry = breakdownById.get(storedId);
        if (!entry) continue;
        for (const contribution of entry.contributions) {
          metrics.perSourceContribution[contribution.source] =
            (metrics.perSourceContribution[contribution.source] ?? 0) + contribution.contribution;
        }
      }
    }

    // Filter events precision
    if (trace?.filterEvents) {
      for (const event of trace.filterEvents) {
        const tracker = filterPrecisionTracker.get(event.filter) ?? { triggered: 0, correct: 0 };
        tracker.triggered += 1;
        if (event.knowledgeId) {
          const knowledge = reverse.get(event.knowledgeId);
          if (knowledge && (knowledge.tier === 'E' || expectedFiltered.has(knowledge.sandboxId))) {
            tracker.correct += 1;
          }
        }
        filterPrecisionTracker.set(event.filter, tracker);
      }
    }
  }

  // Finalize
  metrics.hitRate = metrics.totalPrompts > 0 ? metrics.hits / metrics.totalPrompts : 0;
  metrics.mrr = metrics.totalPrompts > 0 ? metrics.mrr / metrics.totalPrompts : 0;
  metrics.noiseRate = metrics.noiseExpected > 0 ? metrics.noiseHits / Math.max(1, metrics.totalPrompts) : 0;
  metrics.staleSuppressionRate = safeRate(metrics.staleSuppressed, metrics.staleExpected);
  metrics.duplicateSuppressionRate = safeRate(metrics.duplicateSuppressed, metrics.duplicateExpected);
  metrics.adversarialBlockRate = safeRate(metrics.adversarialBlocked, metrics.adversarialExpected);
  metrics.itemTypeCatchAllRate = itemTypeCatchAllCount.totalSelected > 0
    ? itemTypeCatchAllCount.selected / itemTypeCatchAllCount.totalSelected
    : 0;
  metrics.itemTypeDiagonalRate = itemTypeConfusionCount.total > 0
    ? itemTypeConfusionCount.diagonal / itemTypeConfusionCount.total
    : 0;
  metrics.labelDiagonalRate = labelConfusionCount.total > 0
    ? labelConfusionCount.diagonal / labelConfusionCount.total
    : 0;

  for (const [itemType, value] of Object.entries(metrics.perItemType)) {
    value.precision = value.hits > 0 ? value.correctlyHit / value.hits : 0;
    value.recall = value.total > 0 ? value.correctlyHit / value.total : 0;
    if (value.precision > 1 || value.recall > 1) {
      throw new Error(
        `Sandbox perItemType[${itemType}] produced precision=${value.precision} recall=${value.recall} (correctlyHit=${value.correctlyHit}, hits=${value.hits}, total=${value.total}); both must be ≤ 1.`,
      );
    }
    metrics.perItemType[itemType] = value;
  }

  for (const [filter, tracker] of filterPrecisionTracker.entries()) {
    metrics.perFilter[filter] = {
      triggered: tracker.triggered,
      correct: tracker.correct,
      precision: tracker.triggered > 0 ? tracker.correct / tracker.triggered : 0,
    };
  }

  latencies.sort((left, right) => left - right);
  metrics.latency = {
    samples: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
  };

  return metrics;
}


function blankMetrics(): SandboxRunMetrics {
  return {
    totalPrompts: 0,
    hits: 0,
    hitRate: 0,
    mrr: 0,
    staleSuppressed: 0,
    staleExpected: 0,
    staleSuppressionRate: 0,
    duplicateSuppressed: 0,
    duplicateExpected: 0,
    duplicateSuppressionRate: 0,
    adversarialBlocked: 0,
    adversarialExpected: 0,
    adversarialBlockRate: 0,
    noiseHits: 0,
    noiseExpected: 0,
    noiseRate: 0,
    itemTypeCatchAllRate: 0,
    perItemType: {},
    perTier: {
      A: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
      B: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
      C: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
      D: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
      E: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
      F: { selected: 0, suppressed: 0, expectedSelected: 0, expectedSuppressed: 0 },
    },
    perSourceContribution: { metadata: 0, lexical: 0, memory: 0, vector: 0, graph: 0, worktree: 0, atoms: 0, userStyle: 0, convention: 0 },
    perFilter: {},
    latency: { p50: 0, p95: 0, max: 0, samples: 0 },
    itemTypeDiagonalRate: 0,
    itemTypeConfusion: {},
    labelDiagonalRate: 0,
    labelConfusion: {},
  };
}

function collectSelectedKnowledgeIds(pack: ContextPack): string[] {
  const ids: string[] = [];
  for (const section of pack.sections) {
    for (const item of section.items) {
      ids.push(item.knowledgeId);
    }
  }
  return ids;
}

function mapToSandboxIds(knowledgeIds: string[], reverse: Map<string, SandboxKnowledge>): string[] {
  return knowledgeIds.map((id) => reverse.get(id)?.sandboxId).filter((value): value is string => Boolean(value));
}

function sandboxIdToKnowledge(sandboxId: string, fixture: SandboxFixture): SandboxKnowledge | undefined {
  return fixture.knowledge.find((item) => item.sandboxId === sandboxId);
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index]!;
}

function evaluateThresholds(metrics: SandboxRunMetrics, thresholds: SandboxThresholds): string[] {
  const failures: string[] = [];
  if (metrics.hitRate < thresholds.minHitRate) failures.push(`hitRate ${metrics.hitRate.toFixed(3)} < ${thresholds.minHitRate}`);
  if (metrics.mrr < thresholds.minMRR) failures.push(`mrr ${metrics.mrr.toFixed(3)} < ${thresholds.minMRR}`);
  if (metrics.noiseRate > thresholds.maxNoiseRate) failures.push(`noiseRate ${metrics.noiseRate.toFixed(3)} > ${thresholds.maxNoiseRate}`);
  if (metrics.staleSuppressionRate < thresholds.minStaleSuppressionRate) failures.push(`staleSuppressionRate ${metrics.staleSuppressionRate.toFixed(3)} < ${thresholds.minStaleSuppressionRate}`);
  if (metrics.duplicateSuppressionRate < thresholds.minDuplicateSuppressionRate) failures.push(`duplicateSuppressionRate ${metrics.duplicateSuppressionRate.toFixed(3)} < ${thresholds.minDuplicateSuppressionRate}`);
  if (metrics.adversarialBlockRate < thresholds.minAdversarialBlockRate) failures.push(`adversarialBlockRate ${metrics.adversarialBlockRate.toFixed(3)} < ${thresholds.minAdversarialBlockRate}`);
  if (metrics.itemTypeCatchAllRate > thresholds.maxItemTypeCatchAllRate) failures.push(`itemTypeCatchAllRate ${metrics.itemTypeCatchAllRate.toFixed(3)} > ${thresholds.maxItemTypeCatchAllRate}`);
  if (typeof thresholds.minItemTypeDiagonalRate === 'number' && metrics.itemTypeDiagonalRate < thresholds.minItemTypeDiagonalRate) {
    failures.push(`itemTypeDiagonalRate ${metrics.itemTypeDiagonalRate.toFixed(3)} < ${thresholds.minItemTypeDiagonalRate}`);
  }
  if (typeof thresholds.minLabelDiagonalRate === 'number' && metrics.labelDiagonalRate < thresholds.minLabelDiagonalRate) {
    failures.push(`labelDiagonalRate ${metrics.labelDiagonalRate.toFixed(3)} < ${thresholds.minLabelDiagonalRate}`);
  }
  return failures;
}

async function writeReport(reportPath: string, result: SandboxRunResult, fixture: SandboxFixture): Promise<void> {
  const absolute = resolve(reportPath);
  await mkdir(dirname(absolute), { recursive: true });
  const md = renderReport(result, fixture);
  await writeFile(absolute, md, 'utf8');
}

function renderReport(result: SandboxRunResult, fixture: SandboxFixture): string {
  const lines: string[] = [];
  lines.push(`# Sandbox Report`);
  lines.push('');
  lines.push(`- Seed: \`${result.fixtureSeed}\``);
  lines.push(`- Knowledge items: ${result.knowledgeCount}`);
  lines.push(`- Prompts: ${result.promptCount}`);
  lines.push(`- Projects: ${fixture.projects.map((project) => project.id).join(', ')}`);
  lines.push('');
  lines.push(`## Headline Metrics`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| hit rate | ${formatRate(result.metrics.hitRate)} |`);
  lines.push(`| MRR | ${result.metrics.mrr.toFixed(4)} |`);
  lines.push(`| noise rate | ${formatRate(result.metrics.noiseRate)} |`);
  lines.push(`| stale suppression | ${formatRate(result.metrics.staleSuppressionRate)} |`);
  lines.push(`| duplicate suppression | ${formatRate(result.metrics.duplicateSuppressionRate)} |`);
  lines.push(`| adversarial block rate | ${formatRate(result.metrics.adversarialBlockRate)} |`);
  lines.push(`| itemType "memory" catch-all rate | ${formatRate(result.metrics.itemTypeCatchAllRate)} |`);
  lines.push(`| itemType diagonal rate (Phase 3) | ${formatRate(result.metrics.itemTypeDiagonalRate)} |`);
  lines.push(`| label diagonal rate (Phase 3) | ${formatRate(result.metrics.labelDiagonalRate)} |`);
  lines.push(`| latency p50 / p95 / max (ms) | ${result.metrics.latency.p50} / ${result.metrics.latency.p95} / ${result.metrics.latency.max} |`);
  lines.push('');
  lines.push(`## Per-Tier Selection`);
  lines.push('');
  lines.push(`| Tier | selected | expected selected | suppressed | expected suppressed |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const [tier, counts] of Object.entries(result.metrics.perTier)) {
    lines.push(`| ${tier} | ${counts.selected} | ${counts.expectedSelected} | ${counts.suppressed} | ${counts.expectedSuppressed} |`);
  }
  lines.push('');
  lines.push(`## Per-ItemType Hits`);
  lines.push('');
  lines.push(`| itemType | selected | expected | correct | precision | recall |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const [itemType, value] of Object.entries(result.metrics.perItemType)) {
    lines.push(`| ${itemType} | ${value.hits} | ${value.total} | ${value.correctlyHit} | ${formatRate(value.precision)} | ${formatRate(value.recall)} |`);
  }
  lines.push('');
  lines.push(`## Per-Source Fusion Contribution (toward expected items)`);
  lines.push('');
  lines.push(`| source | aggregated contribution |`);
  lines.push(`| --- | --- |`);
  for (const [source, value] of Object.entries(result.metrics.perSourceContribution)) {
    lines.push(`| ${source} | ${value.toFixed(4)} |`);
  }
  lines.push('');
  lines.push(`## Filter Telemetry`);
  lines.push('');
  if (Object.keys(result.metrics.perFilter).length === 0) {
    lines.push('_No filter events were emitted during this run._');
  } else {
    lines.push(`| filter | triggered | correct | precision |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const [filter, value] of Object.entries(result.metrics.perFilter)) {
      lines.push(`| ${filter} | ${value.triggered} | ${value.correct} | ${formatRate(value.precision)} |`);
    }
  }
  lines.push('');
  if (result.ablation && result.ablation.length > 0) {
    lines.push(`## Fusion Ablation`);
    lines.push('');
    lines.push(`| disabled source | hit rate | MRR |`);
    lines.push(`| --- | --- | --- |`);
    for (const row of result.ablation) {
      lines.push(`| ${row.disabled} | ${formatRate(row.hitRate)} | ${row.mrr.toFixed(4)} |`);
    }
    lines.push('');
  }
  lines.push(`## Thresholds`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(result.thresholds, null, 2));
  lines.push('```');
  lines.push('');
  if (result.failures.length === 0) {
    lines.push(`**Status:** all thresholds passed.`);
  } else {
    lines.push(`**Status:** ${result.failures.length} threshold(s) failed.`);
    lines.push('');
    for (const failure of result.failures) {
      lines.push(`- ${failure}`);
    }
  }
  return lines.join('\n') + '\n';
}

function printSummary(result: SandboxRunResult): void {
  console.log(`Sandbox seed=${result.fixtureSeed} knowledge=${result.knowledgeCount} prompts=${result.promptCount}`);
  console.log(`hit=${formatRate(result.metrics.hitRate)} mrr=${result.metrics.mrr.toFixed(4)} noise=${formatRate(result.metrics.noiseRate)}`);
  console.log(`stale_sup=${formatRate(result.metrics.staleSuppressionRate)} dup_sup=${formatRate(result.metrics.duplicateSuppressionRate)} adv_block=${formatRate(result.metrics.adversarialBlockRate)}`);
  console.log(`catchall=${formatRate(result.metrics.itemTypeCatchAllRate)} latency_p50=${result.metrics.latency.p50}ms p95=${result.metrics.latency.p95}ms`);
  console.log(`itemType_diag=${formatRate(result.metrics.itemTypeDiagonalRate)} label_diag=${formatRate(result.metrics.labelDiagonalRate)}`);
  if (result.ablation) {
    for (const row of result.ablation) {
      console.log(`  ablate-${row.disabled}: hit=${formatRate(row.hitRate)} mrr=${row.mrr.toFixed(4)}`);
    }
  }
  if (result.failures.length === 0) {
    console.log('thresholds: PASS');
  } else {
    console.log(`thresholds: FAIL (${result.failures.length})`);
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
  }
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function loadThresholds(path: string): Promise<SandboxThresholds> {
  const absolute = resolve(path);
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(absolute, 'utf8');
  return JSON.parse(raw) as SandboxThresholds;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    reportPath: 'eval/sandbox/report.md',
    thresholdsPath: 'eval/sandbox/thresholds.json',
    seed: 0xC0FFEE,
    ablate: false,
    failUnder: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--ablate') {
      options.ablate = true;
    } else if (arg === '--fail-under') {
      options.failUnder = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--report') {
      options.reportPath = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === '--thresholds') {
      options.thresholdsPath = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(readOptionValue(args, index, arg));
      if (!Number.isFinite(options.seed)) {
        throw new Error('--seed must be a number');
      }
      index += 1;
    } else if (arg === '--') {
      continue;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: pnpm run sandbox -- [options]',
    '',
    'Options:',
    '  --report <path>          Output Markdown report path (default eval/sandbox/report.md)',
    '  --thresholds <path>      Threshold JSON path (default eval/sandbox/thresholds.json)',
    '  --seed <number>          Fixture seed (default 12648430)',
    '  --ablate                 Also run fusion ablation rows',
    '  --fail-under             Exit non-zero if thresholds fail',
    '  --json                   Print full JSON result',
    '  -h, --help               Show this help',
  ].join('\n');
}

const SANDBOX_CONFIG: AppConfig = {
  env: 'sandbox',
  http: {
    port: 3027,
    host: '127.0.0.1',
    requireApiKeyForNonLoopback: false,
    maxRequestBytes: 10 * 1024 * 1024,
  },
  storage: {
    databaseUrl: '',
    redisUrl: '',
    store: 'memory',
    cache: 'memory',
    autoMigrate: false,
  },
  model: {
    provider: 'hash',
    openAiTimeoutMs: 30_000,
    embeddingDimensions: 1536,
    embeddingModel: 'Xenova/bge-small-en-v1.5',
    openAiEmbeddingModel: 'text-embedding-3-small',
    llmCriticEnabled: false,
  },
  context: {
    cacheTtlSeconds: 0,
  },
  ingest: {
    maxContentBytes: 2 * 1024 * 1024,
  },
  backup: {
    dir: '.tuberosa/test-backups',
    exportBaseDir: '.tuberosa/test-exports',
    importBaseDir: '.tuberosa/test-imports',
    intervalSeconds: 0,
    startupDelaySeconds: 0,
    retentionCount: 24,
    retentionMaxAgeDays: 30,
    writeThrough: false,
    writeThroughThrottleSeconds: 600,
  },
  mirror: {
    debounceMs: 500,
  },
  errorLog: {
    dir: '.tuberosa/test-error-logs',
    maxBytes: 256 * 1024,
    autoCapture: true,
    captureClientErrors: false,
  },
  worktree: {
    enabled: true,
    maxFiles: 50,
    maxMtimeAgeHours: 72,
  },
  archival: {
    enabled: false,
    intervalHours: 24,
  },
  graphInference: {
    enabled: false,
  },
  atlas: {},
  userStyle: {},
  persistReplay: false,
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
