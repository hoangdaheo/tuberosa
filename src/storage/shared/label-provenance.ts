import type { KnowledgeInput, LabelInput } from '../../types.js';
import { normalizeLabel } from '../../util/text.js';

export const LABEL_PROVENANCE_METADATA_KEY = 'labelProvenance';

export function labelProvenanceKey(label: { type: string; value: string }): string {
  return `${label.type}:${normalizeLabel(label.value)}`;
}

export function buildLabelProvenanceMap(labels: LabelInput[]): Record<string, LabelInput['provenance']> {
  const map: Record<string, LabelInput['provenance']> = {};
  for (const label of labels) {
    if (label.provenance) {
      map[labelProvenanceKey(label)] = label.provenance;
    }
  }
  return map;
}

export function mergeLabelProvenanceIntoMetadata(
  metadata: Record<string, unknown>,
  labels: LabelInput[],
): Record<string, unknown> {
  const provenanceMap = buildLabelProvenanceMap(labels);
  if (Object.keys(provenanceMap).length === 0) {
    if (!(LABEL_PROVENANCE_METADATA_KEY in metadata)) {
      return metadata;
    }
    const next = { ...metadata };
    delete next[LABEL_PROVENANCE_METADATA_KEY];
    return next;
  }
  return { ...metadata, [LABEL_PROVENANCE_METADATA_KEY]: provenanceMap };
}

export function withLabelProvenanceMetadata(input: KnowledgeInput): KnowledgeInput {
  if (!input.labels || input.labels.length === 0) {
    return input;
  }
  const baseMetadata = input.metadata ?? {};
  const next = mergeLabelProvenanceIntoMetadata(baseMetadata, input.labels);
  if (next === baseMetadata) {
    return input;
  }
  return { ...input, metadata: next };
}
