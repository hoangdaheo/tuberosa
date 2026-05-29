import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { StoredKnowledge } from '../types.js';
import type { BundleManifest, BundleEdge } from '../types/export-bundle.js';
import type { BootstrapHealth } from '../bootstrap/types.js';
import type { AtomGraphDensity } from '../operations/atom-graph-density.js';
import { serializeAtom } from './atom-codec.js';
import { serializeKnowledge } from './knowledge-codec.js';
import { serializeEdges } from './edges-codec.js';
import { sha256OfBuffer, writeManifest, SCHEMA_VERSION } from './manifest.js';
import { README_TEMPLATE } from './readme-template.js';
import { buildAreaModel } from '../knowledge-areas/area-model.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';

export interface ExportBootstrapPackOptions {
  project: string;
  out: string;
  atlasContents: { name: string; content: string }[];
  atlasInputHash?: string;
  health: BootstrapHealth;
  sourceCommit?: string;
  graphDensity?: AtomGraphDensity;
  includeArchived?: boolean;
  includeChunks?: boolean;
}

export interface ExportBootstrapPackReport {
  out: string;
  atoms: number;
  knowledge: number;
  edges: number;
  chunks: number;
  areas: number;
}

const EXPORTED_KNOWLEDGE_TYPES = new Set(['wiki', 'spec', 'code_ref', 'workflow', 'rule', 'conversation']);

/** Map an area key (e.g. "src/retrieval") to a filesystem-safe slug. */
export function slugifyAreaKey(key: string): string {
  const slug = key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : '_unassigned';
}

export async function exportBootstrapPack(
  store: KnowledgeStore,
  opts: ExportBootstrapPackOptions,
): Promise<ExportBootstrapPackReport> {
  const safety = new KnowledgeSafetyService();
  const packDir = join(opts.out, 'pack');

  const areas = await buildAreaModel(store, opts.project);
  const atomAreaSlug = new Map<string, string>();
  const knowledgeAreaSlug = new Map<string, string>();
  const slugLabelMap = new Map<string, string>();
  for (const area of areas) {
    const slug = slugifyAreaKey(area.key);
    slugLabelMap.set(slug, area.label);
    for (const id of area.atomIds) atomAreaSlug.set(id, slug);
    for (const id of area.knowledgeIds) knowledgeAreaSlug.set(id, slug);
  }

  await mkdir(join(opts.out, 'atlas'), { recursive: true });
  await mkdir(join(opts.out, 'health'), { recursive: true });
  await mkdir(join(packDir, 'areas'), { recursive: true });

  const allAtoms = await store.listAtoms({ project: opts.project, limit: 10_000 });
  const atoms = opts.includeArchived ? allAtoms : allAtoms.filter((a) => a.status === 'active');
  const perArea = new Map<string, { atoms: number; knowledge: number; label: string }>();
  const bump = (slug: string, key: 'atoms' | 'knowledge') => {
    const cur = perArea.get(slug) ?? { atoms: 0, knowledge: 0, label: slugLabelMap.get(slug) ?? slug };
    cur[key] += 1;
    perArea.set(slug, cur);
  };
  for (const atom of atoms) {
    const slug = atomAreaSlug.get(atom.id) ?? '_unassigned';
    const dir = join(packDir, 'areas', slug, 'atoms');
    await mkdir(dir, { recursive: true });
    const safe: KnowledgeAtom = { ...atom, claim: safety.redactSecrets(atom.claim) };
    const { content, filename } = serializeAtom(safe, { revision: atom.reuseCount + 1 });
    await writeFile(join(dir, filename), content, 'utf8');
    bump(slug, 'atoms');
  }

  const allKnowledge = await store.listKnowledge({ project: opts.project, limit: 10_000 });
  const knowledge = allKnowledge.filter((k) => {
    if (!EXPORTED_KNOWLEDGE_TYPES.has(k.itemType)) return false;
    if (k.status && k.status !== 'approved') return false;
    if ((k.metadata as { legacyStatus?: string } | undefined)?.legacyStatus) return false;
    return true;
  });
  for (const item of knowledge) {
    const slug = knowledgeAreaSlug.get(item.id) ?? '_unassigned';
    const dir = join(packDir, 'areas', slug, 'knowledge');
    await mkdir(dir, { recursive: true });
    const safe: StoredKnowledge = { ...item, content: safety.redactSecrets(item.content) };
    const { content, filename } = serializeKnowledge(safe);
    await writeFile(join(dir, filename), content, 'utf8');
    bump(slug, 'knowledge');
  }

  const atomIds = new Set(atoms.map((a) => a.id));
  const allRelations = await store.listAtomRelations({ limit: 100_000 });
  const bundleEdges: BundleEdge[] = allRelations
    .filter((r) => atomIds.has(r.fromAtomId) && atomIds.has(r.targetAtomId))
    .map((r) => ({ from: r.fromAtomId, to: r.targetAtomId, kind: r.relationType, confidence: r.confidence, inferenceSource: r.inferenceSource }));
  const edgesContent = serializeEdges(bundleEdges);
  await writeFile(join(packDir, 'edges.jsonl'), edgesContent, 'utf8');

  let chunks = 0;
  if (opts.includeChunks !== false && knowledge.length > 0) {
    const chunkRecords = await store.listKnowledgeChunks(knowledge.map((k) => k.id));
    await mkdir(join(packDir, 'chunks'), { recursive: true });
    for (const chunk of chunkRecords) {
      await mkdir(join(packDir, 'chunks', chunk.knowledgeId), { recursive: true });
      await writeFile(join(packDir, 'chunks', chunk.knowledgeId, `${chunk.chunkIndex}.txt`), safety.redactSecrets(chunk.content), 'utf8');
      chunks += 1;
    }
  }

  await writeFile(join(packDir, 'README.md'), README_TEMPLATE, 'utf8');

  for (const file of opts.atlasContents) {
    await writeFile(join(opts.out, 'atlas', file.name), file.content, 'utf8');
  }

  await writeFile(
    join(opts.out, 'health', 'source-health.json'),
    JSON.stringify({ sourceCounts: opts.health.sourceCounts, tombstones: opts.health.tombstones }, null, 2),
    'utf8',
  );
  await writeFile(
    join(opts.out, 'health', 'maintenance-preview.json'),
    JSON.stringify({ maintenanceItems: opts.health.maintenanceItems, openImportConflicts: opts.health.openImportConflicts, gaps: opts.health.gaps }, null, 2),
    'utf8',
  );
  const areaSummaryRows = [...perArea.entries()].sort().map(([slug, c]) => `- **${slug}** — ${c.atoms} atoms, ${c.knowledge} knowledge`);
  await writeFile(
    join(opts.out, 'health', 'summary.md'),
    [
      `# Health Summary — ${opts.project}`,
      '',
      `- Tracked sources: ${opts.health.sourceCounts.tracked}`,
      `- Tombstones: ${opts.health.tombstones}`,
      `- Open import conflicts: ${opts.health.openImportConflicts}`,
      `- Maintenance items: ${opts.health.maintenanceItems}`,
      `- Knowledge gaps: ${opts.health.gaps}`,
      '',
      '## Areas',
      ...areaSummaryRows,
      '',
    ].join('\n'),
    'utf8',
  );

  const areaList = [...perArea.entries()].sort().map(([slug, c]) => `- \`${slug}\` (${c.atoms} atoms, ${c.knowledge} knowledge)`);
  await writeFile(
    join(opts.out, 'START-HERE.md'),
    [
      `# Tuberosa Bootstrap Pack — ${opts.project}`,
      '',
      opts.sourceCommit ? `Source commit: \`${opts.sourceCommit}\`` : 'Source commit: (not available)',
      '',
      '## Quick import',
      '',
      '```bash',
      `# Point the importer at the machine pack (the pack/ subdirectory):`,
      `tuberosa import --from <this-dir>/pack --project ${opts.project}`,
      '```',
      '',
      '## Project areas',
      '',
      ...areaList,
      '',
      '## Health',
      '',
      `Tracked sources: ${opts.health.sourceCounts.tracked} · open conflicts: ${opts.health.openImportConflicts} · gaps: ${opts.health.gaps}`,
      ...(opts.graphDensity ? ['', `Graph density: ${opts.graphDensity.edgesPerAtom.toFixed(2)} edges/atom (${opts.graphDensity.edges} edges).`] : []),
      '',
      'See `atlas/` for the project map and flows, `health/` for the health report, and `pack/` for the importable data.',
      '',
    ].join('\n'),
    'utf8',
  );

  const manifest: BundleManifest = {
    schemaVersion: SCHEMA_VERSION,
    project: opts.project,
    generated: new Date().toISOString(),
    sourceCommit: opts.sourceCommit,
    counts: { atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks },
    integrity: { 'edges.jsonl': sha256OfBuffer(edgesContent) },
    tierPolicy: {
      exportedTiers: ['draft', 'verified', 'canonical'],
      excludedStatuses: opts.includeArchived ? [] : ['archived', 'legacy_archived', 'superseded'],
    },
    includesChunks: opts.includeChunks !== false,
    safetyRedactionVersion: '1',
    layout: 'categorized-v2',
    areas: [...perArea.entries()].sort().map(([slug, c]) => ({ key: slug, label: c.label, atomCount: c.atoms, knowledgeCount: c.knowledge })),
    atlas: { files: opts.atlasContents.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.content, 'utf8') })), inputHash: opts.atlasInputHash },
    healthSummary: {
      sourceCounts: opts.health.sourceCounts,
      openImportConflicts: opts.health.openImportConflicts,
      maintenanceItems: opts.health.maintenanceItems,
      gaps: opts.health.gaps,
    },
  };
  await writeManifest(join(packDir, 'manifest.json'), manifest);

  return { out: opts.out, atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks, areas: perArea.size };
}
