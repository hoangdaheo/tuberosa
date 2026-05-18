import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import type { IngestionService } from '../ingest/service.js';
import { ValidationError } from '../errors.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  LabelInput,
  KnowledgeTaxonomy,
  ReferenceInput,
  ReflectionDraft,
  ReflectionDraftInput,
  ReflectionDraftReviewInput,
} from '../types.js';

export class ReflectionService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
  ) {}

  async createDraft(input: ReflectionDraftInput) {
    const references = input.references ?? metadataReferences(input.metadata);
    const raw = {
      ...input,
      title: input.title.trim(),
      summary: input.summary.trim(),
      content: input.content.trim(),
      itemType: input.itemType ?? 'memory',
      references,
      metadata: reflectionDraftMetadata(input, references),
      labels: normalizeSuggestedLabels([
        ...labelsFromClassification(classifyQuery({
          prompt: `${input.title}\n${input.summary}\n${input.content}`,
          project: input.project,
        })),
        ...(input.labels ?? []),
      ], input, references),
    } satisfies ReflectionDraftInput;
    const normalized = this.safety.sanitizeReflectionDraft(raw);

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
      references: approvedReflectionReferences(draft),
      metadata: approvedReflectionMetadata(draft),
    });

    return draft;
  }

  async reviewDraft(input: ReflectionDraftReviewInput) {
    const metadata = reflectionReviewMetadata(input);

    if (input.decision === 'approve') {
      const patched = await this.store.updateReflectionDraft(input.id, { metadata });
      if (!patched) {
        return undefined;
      }

      return this.approveDraft(input.id);
    }

    return this.store.updateReflectionDraft(input.id, {
      status: input.decision === 'reject' ? 'rejected' : 'needs_changes',
      metadata,
    });
  }
}

function normalizeSuggestedLabels(
  labels: LabelInput[],
  input: ReflectionDraftInput,
  references: ReferenceInput[],
): LabelInput[] {
  const seen = new Set<string>();
  const normalized: LabelInput[] = [];

  for (const label of labels) {
    if (isNoisySuggestedLabel(label, input, references)) {
      continue;
    }

    const key = `${label.type}:${label.value.trim().toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(label);
  }

  return normalized;
}

function isNoisySuggestedLabel(
  label: LabelInput,
  input: ReflectionDraftInput,
  references: ReferenceInput[],
): boolean {
  const value = label.value.trim().toLowerCase();
  if (!value) {
    return true;
  }

  if (label.type === 'symbol') {
    return REFLECTION_SYMBOL_STOP_LABELS.has(value);
  }

  if (label.type === 'technology') {
    return isAmbiguousTechnologyLabel(value, input, references);
  }

  return false;
}

function isAmbiguousTechnologyLabel(
  value: string,
  input: ReflectionDraftInput,
  references: ReferenceInput[],
): boolean {
  const text = `${input.title}\n${input.summary}\n${input.content}`.toLowerCase();

  if (value === 'go') {
    return !(
      /\b(golang|go\s+(?:api|app|code|module|package|project|repo|runtime|server|service))\b/.test(text)
      || references.some((reference) => reference.uri.toLowerCase().endsWith('.go'))
    );
  }

  if (value === 'rest') {
    return !/\b(restful|rest\s+(?:api|client|endpoint|route|server|service)|http\s+rest)\b/.test(text);
  }

  return REFLECTION_AMBIGUOUS_TECH_LABELS.has(value);
}

const REFLECTION_SYMBOL_STOP_LABELS = new Set([
  'continuation',
  'for',
  'keep',
  'pull',
  'strip',
  'the',
  'use',
]);

const REFLECTION_AMBIGUOUS_TECH_LABELS = new Set([
  'go',
  'rest',
]);

function reflectionDraftMetadata(
  input: ReflectionDraftInput,
  references: ReferenceInput[],
): Record<string, unknown> {
  const metadata = input.metadata ?? {};
  const taxonomy = normalizeTaxonomy(metadata.taxonomy, input);

  return {
    ...metadata,
    taxonomy,
    triggerType: input.triggerType,
    references,
    provenance: {
      ...metadataRecord(metadata.provenance),
      agentSessionId: metadataString(metadata, 'agentSessionId'),
      contextPackId: metadataString(metadata, 'contextPackId'),
      triggerType: input.triggerType,
    },
  };
}

function approvedReflectionMetadata(draft: ReflectionDraft): Record<string, unknown> {
  return {
    ...draft.metadata,
    taxonomy: normalizeTaxonomy(draft.metadata.taxonomy, draft),
    triggerType: draft.triggerType,
    approvedDraftId: draft.id,
    references: draft.references,
    provenance: {
      ...metadataRecord(draft.metadata.provenance),
      triggerType: draft.triggerType,
      reflectionDraftId: draft.id,
    },
  };
}

function approvedReflectionReferences(draft: ReflectionDraft): ReferenceInput[] {
  return uniqueReferences([
    { type: 'conversation', uri: `reflection://draft/${draft.id}` },
    ...draft.references,
  ]);
}

function reflectionReviewMetadata(input: ReflectionDraftReviewInput): Record<string, unknown> {
  return compactRecord({
    ...input.metadata,
    review: compactRecord({
      decision: input.decision,
      reviewedAt: new Date().toISOString(),
      reviewer: input.reviewer,
      reviewerNote: input.reviewerNote,
      evaluation: input.evaluation ? compactRecord(input.evaluation) : undefined,
    }),
  });
}

function normalizeTaxonomy(
  value: unknown,
  input: Pick<ReflectionDraftInput, 'itemType' | 'triggerType'>,
): KnowledgeTaxonomy {
  if (isKnowledgeTaxonomy(value)) {
    return value;
  }

  switch (input.itemType) {
    case 'code_ref':
      return 'code_reference';
    case 'rule':
      return 'domain_rule';
    case 'workflow':
      return 'workflow';
    case 'bugfix':
      return 'incident_lesson';
    case 'memory':
      return input.triggerType === 'user_correction' ? 'user_preference' : 'incident_lesson';
    case 'spec':
    case 'wiki':
    case 'conversation':
    case undefined:
      return input.triggerType === 'non_trivial_workflow' ? 'workflow' : 'project_fact';
  }
}

function isKnowledgeTaxonomy(value: unknown): value is KnowledgeTaxonomy {
  return typeof value === 'string' && [
    'project_fact',
    'domain_rule',
    'workflow',
    'user_preference',
    'incident_lesson',
    'code_reference',
  ].includes(value);
}

function metadataReferences(metadata: Record<string, unknown> | undefined): ReferenceInput[] {
  const references = metadata?.references;
  return Array.isArray(references) ? references as ReferenceInput[] : [];
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function uniqueReferences(references: ReferenceInput[]): ReferenceInput[] {
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.type}:${reference.uri}:${reference.lineStart ?? ''}:${reference.lineEnd ?? ''}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function compactRecord(record: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function validateDraft(input: ReflectionDraftInput): void {
  if (input.title.trim().length < 6) {
    throw new ValidationError('Reflection title must be at least 6 characters.');
  }

  if (input.summary.trim().length < 12) {
    throw new ValidationError('Reflection summary must be at least 12 characters.');
  }

  if (input.content.trim().length < 24) {
    throw new ValidationError('Reflection content must be at least 24 characters.');
  }
}
