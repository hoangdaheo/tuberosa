import type { KnowledgeInput, LabelInput, LabelProvenance } from '../types.js';
import { classifyQuery, labelsFromClassification } from '../retrieval/classifier.js';
import { expandLabelsThroughOntology } from '../relations/ontology.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';

export interface LabelEnricherContext {
  /** Optional ID to scope LLM calls (for caching / dedup later). */
  ingestionId?: string;
}

export interface LabelEnricher {
  readonly name: string;
  enrich(input: KnowledgeInput, context?: LabelEnricherContext): Promise<LabelInput[]>;
}

/**
 * Default enricher: re-runs the classifier on title+summary+content to surface
 * project/file/symbol/error/technology/business_area labels, then expands ontology axes.
 * Local-first; never calls the network.
 */
export class HeuristicLabelEnricher implements LabelEnricher {
  readonly name = 'heuristic';

  async enrich(input: KnowledgeInput): Promise<LabelInput[]> {
    const classified = classifyQuery({
      prompt: [input.title, input.summary ?? '', input.content].filter(Boolean).join('\n'),
      project: input.project,
      files: input.references?.filter((reference) => reference.type === 'file').map((reference) => reference.uri),
    });
    const fromClassifier = labelsFromClassification(classified).map((label) => withProvenance(label, {
      source: 'classifier',
      confidence: clampConfidence(0.55 + classified.confidence * 0.4),
    }));

    const policy = getRetrievalPolicy();
    const merged = mergeLabels([
      ...labelsWithProvenance(input.labels ?? [], { source: 'prompt', confidence: 0.95 }),
      ...fromClassifier,
    ]);

    return expandLabelsThroughOntology(merged, { enabled: policy.useOntology });
  }
}

export interface LlmLabelEnricherOptions {
  /** Set false to disable even when env var is on (used by tests). */
  enabled?: boolean;
  /** Optional override provider for tests. When omitted, the LLM enricher returns []. */
  provider?: {
    suggestLabels(input: KnowledgeInput): Promise<LabelInput[]>;
  };
}

/**
 * Optional LLM enricher. Gated by `TUBEROSA_LLM_LABELS=true`. Default ships with a
 * no-op provider so the implementation is wired but inert until a real provider is plugged in.
 * Labels returned carry `provenance: { source: 'llm', confidence }`.
 */
export class LlmLabelEnricher implements LabelEnricher {
  readonly name = 'llm';

  constructor(private readonly options: LlmLabelEnricherOptions = {}) {}

  async enrich(input: KnowledgeInput): Promise<LabelInput[]> {
    if (!this.isActive()) {
      return [];
    }
    const provider = this.options.provider;
    if (!provider) {
      return [];
    }
    try {
      const suggestions = await provider.suggestLabels(input);
      return suggestions.map((label) => withProvenance(label, {
        source: 'llm',
        confidence: clampConfidence(label.provenance?.confidence ?? 0.6),
      }));
    } catch {
      return [];
    }
  }

  private isActive(): boolean {
    if (this.options.enabled === false) return false;
    if (this.options.enabled === true) return true;
    return (process.env.TUBEROSA_LLM_LABELS ?? '').toLowerCase() === 'true';
  }
}

export function mergeLabels(labels: LabelInput[]): LabelInput[] {
  const byKey = new Map<string, LabelInput>();
  for (const label of labels) {
    const key = `${label.type}:${(label.value ?? '').toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, label);
      continue;
    }
    const existingWeight = existing.weight ?? 0;
    const incomingWeight = label.weight ?? 0;
    const winner = incomingWeight > existingWeight ? label : existing;
    const loser = winner === label ? existing : label;
    const winnerConfidence = winner.provenance?.confidence ?? 0;
    const loserConfidence = loser.provenance?.confidence ?? 0;
    byKey.set(key, {
      ...winner,
      provenance: winner.provenance
        ? { ...winner.provenance, confidence: clampConfidence(Math.max(winnerConfidence, loserConfidence)) }
        : winner.provenance,
    });
  }
  return [...byKey.values()];
}

function labelsWithProvenance(labels: LabelInput[], fallback: LabelProvenance): LabelInput[] {
  return labels.map((label) => (label.provenance ? label : withProvenance(label, fallback)));
}

function withProvenance(label: LabelInput, provenance: LabelProvenance): LabelInput {
  return { ...label, provenance };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
