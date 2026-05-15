import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeInput, KnowledgeItemType, LabelInput } from '../types.js';
import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import type { KnowledgeStore } from '../storage/store.js';
import { estimateTokens, splitIntoChunks, uniqueStrings } from '../util/text.js';

export interface IngestFileInput {
  project: string;
  path: string;
  content: string;
  itemType?: KnowledgeItemType;
  labels?: LabelInput[];
  metadata?: Record<string, unknown>;
}

export class IngestionService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
  ) {}

  async ingestKnowledge(input: KnowledgeInput) {
    const chunks = await this.buildChunks(input);
    return this.store.upsertKnowledge(input, chunks);
  }

  async ingestFiles(project: string, files: IngestFileInput[]) {
    const results = [];

    for (const file of files) {
      const itemType = file.itemType ?? inferItemType(file.path);
      const title = file.path.split('/').filter(Boolean).at(-1) ?? file.path;
      const classified = classifyQuery({
        prompt: `${file.path}\n${file.content.slice(0, 2000)}`,
        project,
        files: [file.path],
      });
      const labels = mergeLabels([
        { type: 'project', value: project, weight: 1 },
        { type: 'file', value: file.path, weight: 1 },
        ...labelsFromClassification(classified),
        ...(file.labels ?? []),
      ]);

      results.push(await this.ingestKnowledge({
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
      }));
    }

    return results;
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
