/**
 * The shared P1 area model: partition project knowledge into directory-spine
 * "areas". Pure and deterministic — no model calls — so it is eval-gated.
 */
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';

export interface ProjectArea {
  key: string;
  label: string;
  paths: string[];
  knowledgeIds: string[];
  atomIds: string[];
  labels: { type: string; value: string }[];
  crossingRelations: number;
  counts: { files: number; knowledge: number; atoms: number; verifiedAtoms: number };
}

interface MutableArea extends ProjectArea {
  labelSet: Set<string>; // dedup key "type:value"
}

/** Normalize a repo-relative path to its canonical area key. */
export function deriveAreaKey(path: string): string {
  const clean = path.replace(/^\.\//, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return '_unassigned';
  if (segments.length === 1) return '_root';
  if (segments[0] === 'src') {
    // src/<dir>/<file> → "src/<dir>"; a file directly under src/ keys on "src".
    return segments.length >= 3 ? `src/${segments[1]}` : 'src';
  }
  return segments[0];
}

/** Human label for an area key (title-cased last segment). */
export function areaLabel(key: string): string {
  if (key === '_root') return 'Root';
  if (key === '_unassigned') return 'Unassigned';
  const last = key.split('/').filter(Boolean).pop() ?? key;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** Best-effort file path for an atom: first trigger file, else first file evidence. */
function atomPath(atom: KnowledgeAtom): string | undefined {
  const triggerFile = atom.trigger.files?.find((f) => f.length > 0);
  if (triggerFile) return triggerFile;
  for (const ev of atom.evidence) {
    if (ev.kind === 'file' && ev.path) return ev.path;
  }
  return undefined;
}

function ensureArea(map: Map<string, MutableArea>, key: string): MutableArea {
  let area = map.get(key);
  if (!area) {
    area = {
      key,
      label: areaLabel(key),
      paths: [],
      knowledgeIds: [],
      atomIds: [],
      labels: [],
      crossingRelations: 0,
      counts: { files: 0, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
      labelSet: new Set<string>(),
    };
    map.set(key, area);
  }
  return area;
}

export async function buildAreaModel(store: KnowledgeStore, project: string): Promise<ProjectArea[]> {
  const areas = new Map<string, MutableArea>();

  const files = await store.listSourceFiles({ project, limit: 100_000 });
  for (const file of files) {
    if (file.status === 'archived') continue;
    const area = ensureArea(areas, deriveAreaKey(file.path));
    area.paths.push(file.path);
    area.counts.files += 1;
  }

  const knowledge = await store.listKnowledge({ project, limit: 100_000 });
  for (const item of knowledge) {
    const path = (item.metadata as { sourcePath?: string }).sourcePath;
    const key = path ? deriveAreaKey(path) : '_unassigned';
    const area = ensureArea(areas, key);
    area.knowledgeIds.push(item.id);
    area.counts.knowledge += 1;
    for (const label of item.labels) {
      if (label.type !== 'domain' && label.type !== 'business_area') continue;
      const dedup = `${label.type}:${label.value}`;
      if (!area.labelSet.has(dedup)) {
        area.labelSet.add(dedup);
        area.labels.push({ type: label.type, value: label.value });
      }
    }
  }

  const atomArea = new Map<string, string>();
  const atoms = await store.listAtoms({ project, limit: 100_000 });
  for (const atom of atoms) {
    const path = atomPath(atom);
    const key = path ? deriveAreaKey(path) : '_unassigned';
    atomArea.set(atom.id, key);
    const area = ensureArea(areas, key);
    area.atomIds.push(atom.id);
    area.counts.atoms += 1;
    if (atom.tier === 'verified' || atom.tier === 'canonical') {
      area.counts.verifiedAtoms += 1;
    }
  }

  const relations = await store.listAtomRelations({ project, limit: 1_000_000 });
  const seen = new Set<string>();
  for (const rel of relations) {
    const fromKey = atomArea.get(rel.fromAtomId);
    const toKey = atomArea.get(rel.targetAtomId);
    if (!fromKey || !toKey || fromKey === toKey) continue;
    // Dedup undirected edges so a single relation counts once per endpoint area.
    const canonical = [rel.fromAtomId, rel.targetAtomId].sort().join('|');
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    ensureArea(areas, fromKey).crossingRelations += 1;
    ensureArea(areas, toKey).crossingRelations += 1;
  }

  return finalize(areas);
}

function finalize(areas: Map<string, MutableArea>): ProjectArea[] {
  const result: ProjectArea[] = [];
  for (const area of areas.values()) {
    area.paths.sort();
    area.knowledgeIds.sort();
    area.atomIds.sort();
    area.labels.sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
    const { labelSet: _labelSet, ...clean } = area;
    result.push(clean);
  }
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}
