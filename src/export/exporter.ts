import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { StoredKnowledge } from '../types.js';
import type { BundleManifest, BundleEdge } from '../types/export-bundle.js';
import { serializeAtom } from './atom-codec.js';
import { serializeKnowledge } from './knowledge-codec.js';
import { serializeEdges } from './edges-codec.js';
import { sha256OfBuffer, writeManifest, SCHEMA_VERSION } from './manifest.js';
import { README_TEMPLATE } from './readme-template.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';

export interface ExportOptions {
  project: string;
  out: string;
  includeChunks?: boolean;
  includeArchived?: boolean;
  maxChunkTokens?: number;
  sourceCommit?: string;
  dryRun?: boolean;
}

export interface ExportReport {
  atoms: number;
  knowledge: number;
  edges: number;
  chunks: number;
  outPath: string;
}

const EXPORTED_KNOWLEDGE_TYPES = new Set([
  'wiki', 'spec', 'code_ref', 'workflow', 'rule', 'conversation',
]);

export async function exportPack(
  store: KnowledgeStore,
  opts: ExportOptions,
): Promise<ExportReport> {
  const safety = new KnowledgeSafetyService();

  if (!opts.dryRun) {
    await mkdir(opts.out, { recursive: true });
    await mkdir(join(opts.out, 'atoms'), { recursive: true });
    await mkdir(join(opts.out, 'knowledge'), { recursive: true });
  }

  const allAtoms = await store.listAtoms({ project: opts.project, limit: 10_000 });
  const atoms = opts.includeArchived
    ? allAtoms
    : allAtoms.filter((a) => a.status === 'active');

  for (const atom of atoms) {
    const safe: KnowledgeAtom = { ...atom, claim: safety.redactSecrets(atom.claim) };
    const { content, filename } = serializeAtom(safe, { revision: atom.reuseCount + 1 });
    if (!opts.dryRun) {
      await writeFile(join(opts.out, 'atoms', filename), content, 'utf8');
    }
  }

  const allKnowledge = await store.listKnowledge({ project: opts.project, limit: 10_000 });
  const knowledge = allKnowledge.filter((k) => {
    if (!EXPORTED_KNOWLEDGE_TYPES.has(k.itemType)) return false;
    if (k.status && k.status !== 'approved') return false;
    const legacy = (k.metadata as { legacyStatus?: string } | undefined)?.legacyStatus;
    if (legacy) return false;
    return true;
  });

  for (const item of knowledge) {
    const safe: StoredKnowledge = { ...item, content: safety.redactSecrets(item.content) };
    const { content, filename } = serializeKnowledge(safe);
    if (!opts.dryRun) {
      await writeFile(join(opts.out, 'knowledge', filename), content, 'utf8');
    }
  }

  const atomIds = new Set(atoms.map((a) => a.id));
  const allRelations = await store.listAtomRelations({ limit: 100_000 });
  const bundleEdges: BundleEdge[] = allRelations
    .filter((r) => atomIds.has(r.fromAtomId) && atomIds.has(r.targetAtomId))
    .map((r) => ({
      from: r.fromAtomId,
      to: r.targetAtomId,
      kind: r.relationType,
      confidence: r.confidence,
      inferenceSource: r.inferenceSource,
    }));
  const edgesContent = serializeEdges(bundleEdges);
  if (!opts.dryRun) {
    await writeFile(join(opts.out, 'edges.jsonl'), edgesContent, 'utf8');
  }

  let chunks = 0;
  if (opts.includeChunks !== false) {
    const knowledgeIds = knowledge.map((k) => k.id);
    if (knowledgeIds.length > 0) {
      const chunkRecords = await store.listKnowledgeChunks(knowledgeIds);
      const budget = opts.maxChunkTokens ?? 200_000;
      let used = 0;
      if (!opts.dryRun) {
        await mkdir(join(opts.out, 'chunks'), { recursive: true });
      }
      for (const chunk of chunkRecords) {
        if (used + chunk.tokenEstimate > budget) break;
        if (!opts.dryRun) {
          await mkdir(join(opts.out, 'chunks', chunk.knowledgeId), { recursive: true });
          const safeContent = safety.redactSecrets(chunk.content);
          await writeFile(
            join(opts.out, 'chunks', chunk.knowledgeId, `${chunk.chunkIndex}.txt`),
            safeContent,
            'utf8',
          );
        }
        used += chunk.tokenEstimate;
        chunks += 1;
      }
    }
  }

  if (!opts.dryRun) {
    await writeFile(join(opts.out, 'README.md'), README_TEMPLATE, 'utf8');
  }

  const manifest: BundleManifest = {
    schemaVersion: SCHEMA_VERSION,
    project: opts.project,
    generated: new Date().toISOString(),
    sourceCommit: opts.sourceCommit,
    counts: {
      atoms: atoms.length,
      knowledge: knowledge.length,
      edges: bundleEdges.length,
      chunks,
    },
    integrity: { 'edges.jsonl': sha256OfBuffer(edgesContent) },
    tierPolicy: {
      exportedTiers: ['draft', 'verified', 'canonical'],
      excludedStatuses: opts.includeArchived ? [] : ['archived', 'legacy_archived', 'superseded'],
    },
    includesChunks: opts.includeChunks !== false,
    safetyRedactionVersion: '1',
  };
  if (!opts.dryRun) {
    await writeManifest(join(opts.out, 'manifest.json'), manifest);
  }

  return {
    atoms: atoms.length,
    knowledge: knowledge.length,
    edges: bundleEdges.length,
    chunks,
    outPath: opts.out,
  };
}
