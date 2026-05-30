import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeInput, KnowledgeItemType, LabelInput, ReferenceInput, StoredKnowledge } from '../types.js';
import { IngestionLimitAppError } from '../errors.js';
import { KnowledgeRelationInference } from '../relations/inference.js';
import { expandLabelsThroughOntology } from '../relations/ontology.js';
import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';
import type { KnowledgeStore } from '../storage/store.js';
import { estimateTokens, splitIntoChunks, uniqueStrings } from '../util/text.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import { DuplicateDetector } from './duplicate-detector.js';
import { MarkdownAtomizer, type DocumentAtom, type DocumentAtomizer } from './document-atomizer.js';
import { inferItemType } from './item-type-inference.js';
import { HeuristicLabelEnricher, LlmLabelEnricher, mergeLabels as mergeLabelsWithProvenance, type LabelEnricher } from './label-enricher.js';

export type IngestionMode = 'document' | 'atomic';

export interface IngestFileInput {
  project: string;
  path: string;
  content: string;
  itemType?: KnowledgeItemType;
  mode?: IngestionMode;
  labels?: LabelInput[];
  metadata?: Record<string, unknown>;
}

export interface IngestFilesOptions {
  mode?: IngestionMode;
}

export interface IngestFileError {
  path?: string;
  error: string;
}

export interface IngestFilesResult {
  results: StoredKnowledge[];
  errors: IngestFileError[];
}

export interface IngestionServiceOptions {
  atomizers?: DocumentAtomizer[];
  safety?: KnowledgeSafetyService;
  maxContentBytes?: number;
  duplicateDetector?: DuplicateDetector;
  labelEnrichers?: LabelEnricher[];
}

export class IngestionLimitError extends IngestionLimitAppError {}

export class IngestionService {
  private readonly atomizers: DocumentAtomizer[];
  private readonly safety: KnowledgeSafetyService;
  private readonly relationInference: KnowledgeRelationInference;
  private readonly maxContentBytes?: number;
  private readonly duplicateDetector: DuplicateDetector;
  private readonly labelEnrichers: LabelEnricher[];

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    options: IngestionServiceOptions = {},
  ) {
    this.atomizers = options.atomizers ?? [new MarkdownAtomizer()];
    this.safety = options.safety ?? new KnowledgeSafetyService();
    this.relationInference = new KnowledgeRelationInference();
    this.maxContentBytes = options.maxContentBytes;
    this.duplicateDetector = options.duplicateDetector ?? new DuplicateDetector(store, models);
    this.labelEnrichers = options.labelEnrichers ?? [new HeuristicLabelEnricher(), new LlmLabelEnricher()];
  }

  async ingestKnowledge(input: KnowledgeInput) {
    this.ensureContentWithinLimit(input.content);
    const refined = await this.refineInput(input);
    const sanitizedInput = this.safety.sanitizeKnowledgeInput(refined);
    const duplicate = await this.duplicateDetector.assertNotDuplicate(sanitizedInput);
    const augmented = applyDuplicateFlag(sanitizedInput, duplicate);
    const chunks = await this.buildChunks(augmented);
    const stored = await this.store.upsertKnowledge(augmented, chunks);
    await this.store.replaceInferredKnowledgeRelations(stored.id, this.relationInference.infer(stored));
    return stored;
  }

  private async refineInput(input: KnowledgeInput): Promise<KnowledgeInput> {
    const policy = safePolicy();
    // Inference only fires when the caller passed the catch-all `memory` type.
    // Explicit non-memory itemTypes are trusted (callers like reflection-review,
    // CLI ingest, and tests rely on this).
    const shouldInfer = policy.useItemTypeInference && input.itemType === 'memory';
    const inferredItemType = shouldInfer
      ? inferItemType({
          content: input.content,
          metadata: input.metadata,
          references: input.references,
          hint: input.itemType,
        })
      : undefined;

    const baseLabels = input.labels ?? [];
    const enriched: LabelInput[] = [...baseLabels];
    for (const enricher of this.labelEnrichers) {
      try {
        const labels = await enricher.enrich(input);
        // Enricher-derived labels are restricted to *axis* types
        // (technology, business_area, domain, task_type, project). file / symbol / error labels
        // are caller-curated; re-extracting them from raw content tends to surface stop words
        // and trigger continuation intent through incidental keywords, so we deliberately
        // do not add those types via the enricher.
        const additive = labels.filter((label) => isAxisLabelType(label.type));
        enriched.push(...additive);
      } catch {
        // enricher failures are non-fatal — fall back to base labels.
      }
    }
    const mergedLabels = mergeLabelsWithProvenance(enriched);
    const finalLabels = expandLabelsThroughOntology(mergedLabels, { enabled: policy.useOntology });

    return {
      ...input,
      itemType: inferredItemType?.itemType ?? input.itemType,
      labels: finalLabels,
      metadata: inferredItemType
        ? {
            ...(input.metadata ?? {}),
            itemTypeInference: {
              source: 'phase3',
              previous: input.itemType,
              chosen: inferredItemType.itemType,
              confidence: inferredItemType.confidence,
              reasons: inferredItemType.reasons,
            },
          }
        : input.metadata,
    };
  }

  async ingestFiles(
    project: string,
    files: IngestFileInput[],
    options: IngestFilesOptions = {},
  ): Promise<IngestFilesResult> {
    const results: StoredKnowledge[] = [];
    const errors: IngestFileError[] = [];

    for (const file of files) {
      const mode = file.mode ?? options.mode ?? 'document';
      const inputs = this.buildKnowledgeInputs(project, file, mode);
      for (const input of inputs) {
        try {
          results.push(await this.ingestKnowledge(input));
        } catch (error) {
          errors.push({
            path: input.sourceUri ?? file.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await this.deleteStaleAtoms(project, file.path, mode, inputs);
    }

    return { results, errors };
  }

  private async deleteStaleAtoms(
    project: string,
    sourcePath: string,
    mode: IngestionMode,
    inputs: KnowledgeInput[],
  ): Promise<void> {
    const atomicInputs = inputs.filter((input) => input.metadata?.ingestionMode === 'atomic');
    if (mode === 'atomic' && atomicInputs.length === 0) {
      return;
    }

    await this.store.deleteStaleFileAtoms({
      project,
      sourcePath,
      keepSourceUris: mode === 'atomic' ? atomicInputs.map((input) => input.sourceUri) : [],
    });
  }

  private ensureContentWithinLimit(content: string): void {
    if (!this.maxContentBytes) {
      return;
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxContentBytes) {
      throw new IngestionLimitError(`Knowledge content exceeds ${this.maxContentBytes} bytes.`);
    }
  }

  private buildKnowledgeInputs(project: string, file: IngestFileInput, mode: IngestionMode): KnowledgeInput[] {
    if (mode === 'atomic') {
      const atomizer = this.atomizers.find((candidate) => candidate.supports(file.path));
      if (atomizer) {
        return atomizer
          .atomize({ path: file.path, content: file.content })
          .map((atom, index) => this.buildAtomKnowledgeInput(project, file, atom, index));
      }
    }

    return [this.buildDocumentKnowledgeInput(project, file)];
  }

  private buildDocumentKnowledgeInput(project: string, file: IngestFileInput): KnowledgeInput {
    const itemType = file.itemType ?? inferItemTypeFromPath(file.path);
    const title = file.path.split('/').filter(Boolean).at(-1) ?? file.path;
    const classified = classifyQuery({
      prompt: `${file.path}\n${file.content.slice(0, 2000)}`,
      project,
      files: [file.path],
    });
    const labels = mergeLabels([
      ...baseFileLabels(project, file),
      ...labelsFromClassification(classified),
    ]);

    return {
      project,
      sourceType: 'file',
      sourceUri: file.path,
      sourceTitle: title,
      itemType,
      title,
      summary: summarizeContent(file.content),
      content: file.content,
      trustLevel: 70,
      labels,
      references: [{ type: 'file', uri: file.path }],
      metadata: { sourcePath: file.path, ...(file.metadata ?? {}) },
    };
  }

  private buildAtomKnowledgeInput(project: string, file: IngestFileInput, atom: DocumentAtom, index: number): KnowledgeInput {
    const itemType = file.itemType ?? inferItemTypeFromPath(file.path);
    const sourceUri = `${file.path}#${atom.sectionSlug}`;
    const classified = classifyQuery({
      prompt: [
        file.path,
        atom.title,
        atom.sectionPath.join(' '),
        atom.content.slice(0, 2000),
      ].join('\n'),
      project,
      files: [file.path],
    });
    const labels = mergeLabels([
      ...baseFileLabels(project, file),
      ...atom.sectionPath.map((section) => ({ type: 'domain' as const, value: section, weight: 0.65 })),
      ...labelsFromClassification(classified),
    ]);
    const reference: ReferenceInput = {
      type: 'file',
      uri: file.path,
      lineStart: atom.lineStart,
      lineEnd: atom.lineEnd,
      metadata: {
        sectionPath: atom.sectionPath,
        sectionSlug: atom.sectionSlug,
      },
    };

    return {
      project,
      sourceType: 'file',
      sourceUri,
      sourceTitle: atom.title,
      itemType,
      title: atom.title,
      summary: atom.summary,
      content: atom.content,
      trustLevel: 70,
      labels,
      references: [reference],
      metadata: {
        ...(file.metadata ?? {}),
        ingestionMode: 'atomic',
        sourcePath: file.path,
        sectionPath: atom.sectionPath,
        sectionSlug: atom.sectionSlug,
        headingLevel: atom.headingLevel,
        lineStart: atom.lineStart,
        lineEnd: atom.lineEnd,
        atomIndex: index,
        // Phase 4 — breadcrumb prefix indexed via contextualContent for parent-doc topic retrieval.
        breadcrumb: atom.breadcrumb,
      },
    };
  }

  private async buildChunks(input: KnowledgeInput) {
    const chunks = splitIntoChunks(input.content);
    const labels = (input.labels ?? []).map((label) => `${label.type}:${label.value}`).join(', ');
    const refs = (input.references ?? []).map((reference) => reference.uri).join(', ');

    // Phase 4 — when the atomizer set a breadcrumb on this knowledge's metadata, prepend
    // it to contextualContent so embedding + FTS see the parent-doc heading chain. The
    // breadcrumb format is `<source-path> > <h1> > <h2> > <h3>`. Heuristic-only; no LLM.
    // Disable via TUBEROSA_CONTEXTUAL_PREFIX_ENABLED=false (default on per the plan flags table).
    const breadcrumbEnabled = process.env.TUBEROSA_CONTEXTUAL_PREFIX_ENABLED !== 'false';
    const breadcrumb = breadcrumbEnabled
      ? typeof input.metadata?.breadcrumb === 'string' && input.metadata.breadcrumb.trim().length > 0
        ? input.metadata.breadcrumb.trim()
        : undefined
      : undefined;

    return Promise.all(chunks.map(async (chunk, index) => {
      const contextualContent = [
        breadcrumb ? `Breadcrumb: ${breadcrumb}` : undefined,
        `Project: ${input.project}`,
        `Knowledge type: ${input.itemType}`,
        `Title: ${input.title}`,
        input.summary ? `Summary: ${input.summary}` : undefined,
        labels ? `Labels: ${labels}` : undefined,
        refs ? `References: ${refs}` : undefined,
        '',
        chunk,
      ].filter((line): line is string => typeof line === 'string').join('\n');

      return {
        index,
        content: chunk,
        contextualContent,
        tokenEstimate: estimateTokens(contextualContent),
        embedding: await this.models.embed(contextualContent),
        metadata: {
          sourceUri: input.sourceUri,
          sourceType: input.sourceType,
        },
      };
    }));
  }
}

const AXIS_LABEL_TYPES = new Set<LabelInput['type']>(['technology', 'business_area', 'domain', 'task_type', 'project']);

function isAxisLabelType(type: LabelInput['type']): boolean {
  return AXIS_LABEL_TYPES.has(type);
}

function safePolicy() {
  try {
    return getRetrievalPolicy();
  } catch {
    return { useItemTypeInference: true, useOntology: true } as ReturnType<typeof getRetrievalPolicy>;
  }
}

export function inferItemTypeFromPath(path: string): KnowledgeItemType {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.includes('/docs/') || lower.includes('/wiki/')) {
    return 'wiki';
  }

  if (lower.includes('spec') || lower.includes('requirements')) {
    return 'spec';
  }

  return 'code_ref';
}

function baseFileLabels(project: string, file: IngestFileInput): LabelInput[] {
  return [
    { type: 'project', value: project, weight: 1 },
    { type: 'file', value: file.path, weight: 1 },
    ...(file.labels ?? []),
  ];
}

function summarizeContent(content: string): string {
  const firstParagraph = content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).find(Boolean) ?? content.trim();
  return firstParagraph.slice(0, 360);
}

function applyDuplicateFlag(input: KnowledgeInput, duplicate: { decision: string; jaccard: number; cosine: number; match?: { id: string } }): KnowledgeInput {
  if (duplicate.decision !== 'flag' || !duplicate.match) {
    return input;
  }
  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      duplicateCandidate: {
        of: duplicate.match.id,
        jaccard: duplicate.jaccard,
        cosine: duplicate.cosine,
        detectedAt: new Date().toISOString(),
      },
    },
  };
}

function mergeLabels(labels: LabelInput[]): LabelInput[] {
  const keys = uniqueStrings(labels.map((label) => `${label.type}:${label.value}`));
  return keys.map((key) => {
    const [type, ...rest] = key.split(':');
    const value = rest.join(':');
    const matches = labels.filter((label) => label.type === type && label.value === value);
    return {
      type: type as LabelInput['type'],
      value,
      weight: Math.max(...matches.map((label) => label.weight ?? 1)),
    };
  });
}
