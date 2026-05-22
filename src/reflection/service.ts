import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import { inferItemType } from '../ingest/item-type-inference.js';
import type { IngestionService } from '../ingest/service.js';
import { ValidationError } from '../errors.js';
import type { ModelProvider } from '../model/provider.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import { recommendDraft, type DraftRecommendation } from './recommendation.js';
import { computeWriteGate, type WriteGateResult } from './write-gate.js';
import type {
  LabelInput,
  KnowledgeTaxonomy,
  ReferenceInput,
  ReflectionDraft,
  ReflectionDraftInput,
  ReflectionDraftPatchInput,
  ReflectionDraftReviewInput,
  SearchCandidate,
} from '../types.js';

export class ReflectionService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
    /** Phase 6b — optional model provider for write-gate cosine. Falls back to candidate rawScore proxy when omitted. */
    private readonly models?: ModelProvider,
  ) {}

  async createDraft(input: ReflectionDraftInput) {
    const references = input.references ?? metadataReferences(input.metadata);
    const inferredItemType = input.itemType ?? inferItemType({
      content: `${input.title}\n${input.summary}\n${input.content}`,
      metadata: { triggerType: input.triggerType, ...(input.metadata ?? {}) },
      references,
    }).itemType;
    const raw = {
      ...input,
      title: input.title.trim(),
      summary: input.summary.trim(),
      content: input.content.trim(),
      itemType: inferredItemType,
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

    // Phase 6b — compute the local-heuristic write-gate decision before
    // persistence so the draft carries the recommendation for evaluateGates
    // and the workbench. NEVER auto-mutates — only sets metadata.writeGate.
    const writeGate = await computeWriteGate({
      draft: {
        title: normalized.title,
        summary: normalized.summary,
        content: normalized.content,
        labels: normalized.labels ?? [],
        references: normalized.references ?? [],
      },
      candidates: duplicates as SearchCandidate[],
      models: this.models,
    });
    const draftWithGate: ReflectionDraftInput = {
      ...normalized,
      metadata: {
        ...(normalized.metadata ?? {}),
        writeGate: serializeWriteGate(writeGate),
      },
    };

    return this.store.createReflectionDraft(draftWithGate, duplicates);
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

  async updateDraft(id: string, patch: ReflectionDraftPatchInput): Promise<ReflectionDraft | undefined> {
    const hasLabelOrReferenceChange = patch.suggestedLabels !== undefined || patch.references !== undefined;
    if (!hasLabelOrReferenceChange) {
      return this.store.updateReflectionDraft(id, patch);
    }

    const current = await this.store.getReflectionDraft(id);
    if (!current) {
      return undefined;
    }

    const baseInput: ReflectionDraftInput = {
      project: current.project,
      title: current.title,
      summary: current.summary,
      content: current.content,
      itemType: current.itemType,
      triggerType: current.triggerType,
      metadata: current.metadata,
    };
    const nextReferences = patch.references !== undefined
      ? this.sanitizeReferences(patch.references)
      : current.references;
    const nextLabels = patch.suggestedLabels !== undefined
      ? normalizeSuggestedLabels(this.sanitizeLabels(patch.suggestedLabels), baseInput, nextReferences)
      : current.suggestedLabels;

    return this.store.updateReflectionDraft(id, {
      ...patch,
      suggestedLabels: nextLabels,
      references: patch.references !== undefined ? nextReferences : undefined,
    });
  }

  private sanitizeLabels(labels: LabelInput[]): LabelInput[] {
    return labels.map((label) => ({
      ...label,
      value: this.safety.redactSecrets(label.value).trim(),
    })).filter((label) => label.value.length > 0);
  }

  private sanitizeReferences(references: ReferenceInput[]): ReferenceInput[] {
    return references.map((reference) => ({
      ...reference,
      uri: this.safety.redactSecrets(reference.uri).trim(),
    })).filter((reference) => reference.uri.length > 0);
  }

  async recommendDraft(id: string): Promise<DraftRecommendation | undefined> {
    return recommendDraft(this.store, id);
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

function serializeWriteGate(gate: WriteGateResult): Record<string, unknown> {
  return {
    decision: gate.decision,
    reason: gate.reason,
    scores: {
      cosine: round(gate.scores.cosine),
      labelOverlap: round(gate.scores.labelOverlap),
      referenceOverlap: round(gate.scores.referenceOverlap),
      recencyDays: Number.isFinite(gate.scores.recencyDays) ? round(gate.scores.recencyDays) : null,
    },
    evidenceIds: gate.evidenceIds,
    ...(gate.closestKnowledgeId ? { closestKnowledgeId: gate.closestKnowledgeId } : {}),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
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
