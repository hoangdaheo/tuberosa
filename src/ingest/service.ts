import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeInput, KnowledgeItemType, LabelInput, ReferenceInput } from '../types.js';
import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import type { KnowledgeStore } from '../storage/store.js';
import { estimateTokens, splitIntoChunks, uniqueStrings } from '../util/text.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import { MarkdownAtomizer, type DocumentAtom, type DocumentAtomizer } from './document-atomizer.js';

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

export interface IngestionServiceOptions {
  atomizers?: DocumentAtomizer[];
  safety?: KnowledgeSafetyService;
  maxContentBytes?: number;
}

export class IngestionLimitError extends Error {
  readonly statusCode = 413;
}

export class IngestionService {
  private readonly atomizers: DocumentAtomizer[];
  private readonly safety: KnowledgeSafetyService;
  private readonly maxContentBytes?: number;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    options: IngestionServiceOptions = {},
  ) {
    this.atomizers = options.atomizers ?? [new MarkdownAtomizer()];
    this.safety = options.safety ?? new KnowledgeSafetyService();
    this.maxContentBytes = options.maxContentBytes;
  }

  async ingestKnowledge(input: KnowledgeInput) {
    this.ensureContentWithinLimit(input.content);
    const sanitizedInput = this.safety.sanitizeKnowledgeInput(input);
    const chunks = await this.buildChunks(sanitizedInput);
    return this.store.upsertKnowledge(sanitizedInput, chunks);
  }

  async ingestFiles(project: string, files: IngestFileInput[], options: IngestFilesOptions = {}) {
    const results = [];

    for (const file of files) {
      const mode = file.mode ?? options.mode ?? 'document';
      const inputs = this.buildKnowledgeInputs(project, file, mode);
      for (const input of inputs) {
        results.push(await this.ingestKnowledge(input));
      }
      await this.deleteStaleAtoms(project, file.path, mode, inputs);
    }

    return results;
  }

  private async deleteStaleAtoms(
    project: string,
    sourcePath: string,
    mode: IngestionMode,
    inputs: KnowledgeInput[],
  ): Promise<void> {
    const atomicInputs = inputs.filter((input) => input.metadata?.ingestionMode === 'atomic');
    if (mode !== 'atomic' || atomicInputs.length === 0) {
      return;
    }

    await this.store.deleteStaleFileAtoms({
      project,
      sourcePath,
      keepSourceUris: atomicInputs.map((input) => input.sourceUri),
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
    const itemType = file.itemType ?? inferItemType(file.path);
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
      metadata: file.metadata ?? {},
    };
  }

  private buildAtomKnowledgeInput(project: string, file: IngestFileInput, atom: DocumentAtom, index: number): KnowledgeInput {
    const itemType = file.itemType ?? inferItemType(file.path);
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
      },
    };
  }

  private async buildChunks(input: KnowledgeInput) {
    const chunks = splitIntoChunks(input.content);
    const labels = (input.labels ?? []).map((label) => `${label.type}:${label.value}`).join(', ');
    const refs = (input.references ?? []).map((reference) => reference.uri).join(', ');

    return Promise.all(chunks.map(async (chunk, index) => {
      const contextualContent = [
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

function inferItemType(path: string): KnowledgeItemType {
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
