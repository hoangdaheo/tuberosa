import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { ReflectionDraftInput } from '../types.js';

export class ReflectionService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
  ) {}

  async createDraft(input: ReflectionDraftInput) {
    const normalized = {
      ...input,
      title: input.title.trim(),
      summary: input.summary.trim(),
      content: input.content.trim(),
      itemType: input.itemType ?? 'memory',
      labels: [
        ...labelsFromClassification(classifyQuery({
          prompt: `${input.title}\n${input.summary}\n${input.content}`,
          project: input.project,
        })),
        ...(input.labels ?? []),
      ],
    } satisfies ReflectionDraftInput;

    validateDraft(normalized);

    const classified = classifyQuery({
      prompt: `${normalized.title}\n${normalized.summary}\n${normalized.content}`,
      project: normalized.project,
    });
    const duplicates = await this.store.searchMemories(classified, {
      project: normalized.project,
      limit: 5,
    });

    return this.store.createReflectionDraft(normalized, duplicates);
  }

  async approveDraft(id: string) {
    const draft = await this.store.approveReflectionDraft(id);
    if (!draft) {
      return undefined;
    }

    const project = draft.project ?? 'personal';
    await this.ingestion.ingestKnowledge({
      project,
      sourceType: 'reflection',
      sourceUri: `reflection://draft/${draft.id}`,
      sourceTitle: draft.title,
      itemType: draft.itemType,
      title: draft.title,
      summary: draft.summary,
      content: draft.content,
      trustLevel: 85,
      labels: [
        { type: 'project', value: project, weight: 1 },
        { type: 'user_preference', value: draft.triggerType, weight: 0.7 },
        ...draft.suggestedLabels,
      ],
      references: [{ type: 'conversation', uri: `reflection://draft/${draft.id}` }],
      metadata: {
        triggerType: draft.triggerType,
        approvedDraftId: draft.id,
      },
    });

    return draft;
  }
}

function validateDraft(input: ReflectionDraftInput): void {
  if (input.title.trim().length < 6) {
    throw new Error('Reflection title must be at least 6 characters.');
  }

  if (input.summary.trim().length < 12) {
    throw new Error('Reflection summary must be at least 12 characters.');
  }

  if (input.content.trim().length < 24) {
    throw new Error('Reflection content must be at least 24 characters.');
  }
}
