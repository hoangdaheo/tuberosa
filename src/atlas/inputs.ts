import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore, AtomRelationRow } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { StoredKnowledge, KnowledgeGap } from '../types/knowledge.js';
import type { SourceFileRecord } from '../source-sync/types.js';
import { buildAreaModel, deriveAreaKey, type ProjectArea } from '../knowledge-areas/area-model.js';

export interface AreaDepEdge { from: string; to: string; weight: number }

export interface AtlasInputs {
  project: string;
  repoPath: string;
  generatedAt: string;
  areas: ProjectArea[];
  atoms: KnowledgeAtom[];
  knowledge: StoredKnowledge[];
  relations: AtomRelationRow[];
  ledger: SourceFileRecord[];
  knowledgeGaps: KnowledgeGap[];
  openConflictCount: number;
  scripts: Record<string, string>;
  readmeCommands?: string;
  areaDeps: AreaDepEdge[];
}

/** Best-effort file path for an atom: first trigger file, else first file evidence. */
function atomPath(atom: KnowledgeAtom): string | undefined {
  const t = atom.trigger.files?.find((f) => f.length > 0);
  if (t) return t;
  for (const ev of atom.evidence) if (ev.kind === 'file' && ev.path) return ev.path;
  return undefined;
}

function buildAreaDeps(atoms: KnowledgeAtom[], relations: AtomRelationRow[]): AreaDepEdge[] {
  const areaOf = new Map<string, string>();
  for (const atom of atoms) {
    const p = atomPath(atom);
    areaOf.set(atom.id, p ? deriveAreaKey(p) : '_unassigned');
  }
  const weights = new Map<string, number>();
  for (const rel of relations) {
    if (rel.relationType !== 'depends_on' && rel.relationType !== 'refines') continue;
    const from = areaOf.get(rel.fromAtomId);
    const to = areaOf.get(rel.targetAtomId);
    if (!from || !to || from === to) continue;
    const key = `${from} ${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights.entries()]
    .map(([k, weight]) => {
      const [from, to] = k.split(' ');
      return { from, to, weight };
    })
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
}

async function readScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(repoPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function readReadmeCommands(repoPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repoPath, 'README.md'), 'utf8');
    const m = raw.match(/^#+\s*Commands\b[\s\S]*?(?=\n#+\s|\n*$)/im);
    return m ? m[0].trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function gatherAtlasInputs(
  store: KnowledgeStore,
  opts: { project: string; repoPath: string; generatedAt: string },
): Promise<AtlasInputs> {
  const { project, repoPath, generatedAt } = opts;
  const [areas, atoms, knowledge, relations, ledger, knowledgeGaps, conflicts] = await Promise.all([
    buildAreaModel(store, project),
    store.listAtoms({ project, limit: 100_000 }),
    store.listKnowledge({ project, limit: 100_000 }),
    store.listAtomRelations({ project, limit: 1_000_000 }),
    store.listSourceFiles({ project, limit: 100_000 }),
    store.listKnowledgeGaps({ project, limit: 100_000 }),
    store.listAtomImportConflicts({ project, status: 'open', limit: 100_000 }),
  ]);
  const [scripts, readmeCommands] = await Promise.all([readScripts(repoPath), readReadmeCommands(repoPath)]);
  return {
    project,
    repoPath,
    generatedAt,
    areas,
    atoms,
    knowledge,
    relations,
    ledger,
    knowledgeGaps,
    openConflictCount: conflicts.length,
    scripts,
    readmeCommands,
    areaDeps: buildAreaDeps(atoms, relations),
  };
}
