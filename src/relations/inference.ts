import type {
  KnowledgeRelationInput,
  KnowledgeRelationTargetKind,
  KnowledgeRelationType,
  ReferenceInput,
  StoredKnowledge,
} from '../types.js';
import { normalizeLabel, uniqueStrings } from '../util/text.js';
import { extractAstSymbols, pickAstSourceFromReferences, relationsFromAst } from './ast-extractor.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';

interface RelationSeed {
  relationType: KnowledgeRelationType;
  targetKind: KnowledgeRelationTargetKind;
  targetValue: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export class KnowledgeRelationInference {
  infer(item: StoredKnowledge): KnowledgeRelationInput[] {
    const seeds: RelationSeed[] = [
      ...this.fromLabels(item),
      ...this.fromReferences(item.references),
      ...this.fromMetadata(item.metadata),
      ...this.fromSourceUri(item.sourceUri),
    ];
    const deduped = dedupeRelationSeeds(seeds);

    const baseRelations = deduped.map((seed) => ({
      project: item.project,
      fromKnowledgeId: item.id,
      relationType: seed.relationType,
      targetKind: seed.targetKind,
      targetValue: seed.targetValue,
      confidence: seed.confidence,
      inferred: true,
      metadata: seed.metadata ?? {},
    }));

    const astRelations = this.fromAst(item);
    if (astRelations.length === 0) {
      return baseRelations;
    }
    return mergeRelations(baseRelations, astRelations);
  }

  private fromAst(item: StoredKnowledge): KnowledgeRelationInput[] {
    let useAst = true;
    try {
      useAst = getRetrievalPolicy().useAstExtractor;
    } catch {
      useAst = true;
    }
    if (!useAst) return [];

    const filename = pickAstSourceFromReferences(item.references) ?? item.sourceUri;
    if (!filename) return [];

    const result = extractAstSymbols(item.content, { filename });
    return relationsFromAst(item, result);
  }

  private fromLabels(item: StoredKnowledge): RelationSeed[] {
    const seeds: RelationSeed[] = [];

    for (const label of item.labels) {
      if (label.type === 'file') {
        seeds.push({
          relationType: 'mentions_file',
          targetKind: 'file',
          targetValue: label.value,
          confidence: label.weight ?? 0.9,
          metadata: { source: 'label:file' },
        });
      }

      if (label.type === 'symbol') {
        seeds.push({
          relationType: 'mentions_symbol',
          targetKind: 'symbol',
          targetValue: label.value,
          confidence: label.weight ?? 0.85,
          metadata: { source: 'label:symbol' },
        });
      }

      if (label.type === 'error') {
        seeds.push({
          relationType: 'resolves_error',
          targetKind: 'error',
          targetValue: label.value,
          confidence: label.weight ?? 0.85,
          metadata: { source: 'label:error' },
        });
      }
    }

    return seeds;
  }

  private fromReferences(references: ReferenceInput[]): RelationSeed[] {
    return references.flatMap((reference) => {
      const base: RelationSeed = {
        relationType: reference.type === 'conversation' ? 'derived_from_session' : 'references',
        targetKind: reference.type === 'conversation' ? 'session' : referenceTargetKind(reference),
        targetValue: reference.uri,
        confidence: 0.8,
        metadata: {
          source: `reference:${reference.type}`,
          lineStart: reference.lineStart,
          lineEnd: reference.lineEnd,
        },
      };

      if (reference.type !== 'file') {
        return [base];
      }

      return [
        base,
        {
          relationType: 'mentions_file',
          targetKind: 'file',
          targetValue: reference.uri,
          confidence: 0.9,
          metadata: {
            source: 'reference:file',
            lineStart: reference.lineStart,
            lineEnd: reference.lineEnd,
          },
        },
      ];
    });
  }

  private fromMetadata(metadata: Record<string, unknown>): RelationSeed[] {
    const seeds: RelationSeed[] = [];
    const sourcePath = typeof metadata.sourcePath === 'string' ? metadata.sourcePath : undefined;
    if (sourcePath) {
      seeds.push({
        relationType: 'contains',
        targetKind: 'file',
        targetValue: sourcePath,
        confidence: 0.95,
        metadata: { source: 'metadata:sourcePath' },
      });
    }

    const sectionPath = Array.isArray(metadata.sectionPath)
      ? metadata.sectionPath.filter((section): section is string => typeof section === 'string')
      : [];
    sectionPath.forEach((section, index) => {
      seeds.push({
        relationType: 'contains',
        targetKind: 'reference',
        targetValue: sectionPath.slice(0, index + 1).join(' > '),
        confidence: 0.7,
        metadata: { source: 'metadata:sectionPath' },
      });
    });

    const agentSessionId = typeof metadata.agentSessionId === 'string' ? metadata.agentSessionId : undefined;
    if (agentSessionId) {
      seeds.push({
        relationType: 'derived_from_session',
        targetKind: 'session',
        targetValue: agentSessionId,
        confidence: 0.9,
        metadata: { source: 'metadata:agentSessionId' },
      });
    }

    return seeds;
  }

  private fromSourceUri(sourceUri: string | undefined): RelationSeed[] {
    if (!sourceUri) {
      return [];
    }

    return [{
      relationType: 'references',
      targetKind: sourceUri.includes('://') ? 'reference' : 'file',
      targetValue: sourceUri,
      confidence: 0.75,
      metadata: { source: 'sourceUri' },
    }];
  }
}

function referenceTargetKind(reference: ReferenceInput): KnowledgeRelationTargetKind {
  if (reference.type === 'file') {
    return 'file';
  }

  return 'reference';
}

function mergeRelations(
  base: KnowledgeRelationInput[],
  additional: KnowledgeRelationInput[],
): KnowledgeRelationInput[] {
  const byKey = new Map<string, KnowledgeRelationInput>();
  for (const relation of [...base, ...additional]) {
    const key = `${relation.relationType}:${relation.targetKind}:${normalizeLabel(relation.targetValue ?? '')}`;
    const existing = byKey.get(key);
    if (!existing || (relation.confidence ?? 0) > (existing.confidence ?? 0)) {
      byKey.set(key, relation);
    }
  }
  return [...byKey.values()];
}

function dedupeRelationSeeds(seeds: RelationSeed[]): RelationSeed[] {
  const byKey = new Map<string, RelationSeed>();

  for (const seed of seeds) {
    const key = [
      seed.relationType,
      seed.targetKind,
      normalizeLabel(seed.targetValue),
    ].join(':');
    const existing = byKey.get(key);
    if (!existing || seed.confidence > existing.confidence) {
      byKey.set(key, {
        ...seed,
        targetValue: seed.targetValue.trim(),
      });
    }
  }

  return uniqueStrings([...byKey.keys()]).map((key) => byKey.get(key)).filter((seed): seed is RelationSeed => Boolean(seed));
}
