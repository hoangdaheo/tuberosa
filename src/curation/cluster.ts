import type { KnowledgeAtom, Trigger } from '../types/atoms.js';

/**
 * Pure clustering of un-curated knowledge atoms.
 *
 * Groups related raw atoms so a later distillation step can turn each cluster
 * into a single convention. This module is fully deterministic — no model
 * calls, no I/O, no Date.now, no Math.random — because clustering is part of
 * the retrieval/eval contract.
 *
 * Clustering is currently driven by trigger-key Jaccard overlap (files /
 * symbols / errors). KnowledgeAtom does not expose a readable embedding, so
 * cosine clustering over atom embeddings is a future enhancement to add once
 * stored atoms carry retrievable vectors.
 */

export interface AtomCluster {
  atoms: KnowledgeAtom[];
  /**
   * The trigger fields shared by EVERY member of the cluster (intersection of
   * files / symbols / errors / taskTypes). Distillation uses this as the
   * anchor for the convention's trigger.
   */
  sharedTrigger: Trigger;
  /** v1 always proposes project scope for distilled conventions. */
  suggestedScope: 'project';
}

export interface ClusterOptions {
  /** Single-linkage Jaccard threshold; pairs at or above this link. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.5;

/**
 * Jaccard similarity over two string sets.
 *
 * Duplicated from the private helper in `src/reflection/write-gate.ts`
 * (which is under the retrieval/learning eval gate and must not be modified).
 */
function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const key of left) if (right.has(key)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a namespaced key-set from an atom's trigger, covering files, symbols
 * and errors. Namespacing prevents cross-type collisions (e.g. a file named
 * the same as a symbol).
 */
function keySet(trigger: Trigger): Set<string> {
  const keys = new Set<string>();
  for (const f of trigger.files ?? []) keys.add(`file:${f}`);
  for (const s of trigger.symbols ?? []) keys.add(`symbol:${s}`);
  for (const e of trigger.errors ?? []) keys.add(`error:${e}`);
  return keys;
}

/** Intersection of a single trigger array across all cluster members. */
function intersectField(values: (string[] | undefined)[]): string[] | undefined {
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  let common = new Set(first ?? []);
  for (const next of rest) {
    const nextSet = new Set(next ?? []);
    common = new Set([...common].filter((v) => nextSet.has(v)));
  }
  const sorted = [...common].sort();
  return sorted.length > 0 ? sorted : undefined;
}

function sharedTriggerOf(atoms: KnowledgeAtom[]): Trigger {
  const trigger: Trigger = {};
  const files = intersectField(atoms.map((a) => a.trigger.files));
  const symbols = intersectField(atoms.map((a) => a.trigger.symbols));
  const errors = intersectField(atoms.map((a) => a.trigger.errors));
  const taskTypes = intersectField(atoms.map((a) => a.trigger.taskTypes));
  if (files) trigger.files = files;
  if (symbols) trigger.symbols = symbols;
  if (errors) trigger.errors = errors;
  if (taskTypes) trigger.taskTypes = taskTypes;
  return trigger;
}

/**
 * Cluster un-curated atoms by single-linkage on trigger-key Jaccard overlap.
 *
 * Exclusions (raw material only):
 * - atoms already distilled into a convention (`metadata.distilledIntoAtomId`)
 * - atoms whose `type === 'convention'` (a curated output, not raw input)
 * - atoms not `status === 'active'` (defensive; caller may pre-filter)
 *
 * Determinism: atoms are processed in `id` order, clusters are merged by
 * single-linkage, and the returned clusters are sorted by their lowest member
 * id (with members themselves sorted by id). Singleton clusters are returned.
 */
export function clusterUncuratedAtoms(
  atoms: KnowledgeAtom[],
  opts: ClusterOptions = {},
): AtomCluster[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const eligible = atoms
    .filter(
      (a) =>
        a.status === 'active' &&
        a.type !== 'convention' &&
        a.metadata?.distilledIntoAtomId === undefined,
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const keys = eligible.map((a) => keySet(a.trigger));

  // Union-find over indices; single-linkage merges any pair at/above threshold.
  const parent = eligible.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Attach higher index under lower to keep roots at the smallest id.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      if (jaccard(keys[i]!, keys[j]!) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, KnowledgeAtom[]>();
  for (let i = 0; i < eligible.length; i += 1) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(eligible[i]!);
    groups.set(root, list);
  }

  const clusters: AtomCluster[] = [];
  for (const members of groups.values()) {
    const sorted = members
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    clusters.push({
      atoms: sorted,
      sharedTrigger: sharedTriggerOf(sorted),
      suggestedScope: 'project',
    });
  }

  clusters.sort((a, b) => {
    const ai = a.atoms[0]!.id;
    const bi = b.atoms[0]!.id;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  return clusters;
}
