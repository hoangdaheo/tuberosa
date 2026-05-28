import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KnowledgeStore } from '../../storage/store.js';
import type { AtomLink, KnowledgeAtom } from '../../types/atoms.js';
import { getRetrievalPolicy } from '../../retrieval/policy.js';
import { syncAtomLinks } from './sync.js';

const execFileAsync = promisify(execFile);

/**
 * Concern C1 — git co-change inference. Files that change together repeatedly
 * imply their underlying atoms drift together; surfacing those pairs as
 * `co_changes_with` edges densifies the graph without an LLM call.
 *
 * Confidence is Jaccard: coOccurrences / (changesA + changesB - coOccurrences).
 * The scheduled worker job runs daily; the CLI lets operators run it on demand
 * (e.g. after a large merge).
 */
export interface CoChangeOptions {
  project: string;
  cwd?: string;
  lookbackCommits?: number;
  minCoChanges?: number;
  minConfidence?: number;
  /** Testing seam: bypass `git log` and pass pre-parsed commits. */
  commitsOverride?: string[][];
}

export interface CoChangePair {
  left: string;
  right: string;
  coOccurrences: number;
  confidence: number;
}

export interface CoChangeReport {
  scannedCommits: number;
  pairsConsidered: number;
  edgesEmitted: number;
}

export async function readGitCommits(cwd: string, lookback: number): Promise<string[][]> {
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--name-only', '--pretty=format:----', '-n', String(lookback)],
    { cwd, maxBuffer: 50 * 1024 * 1024 },
  );
  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '----') {
      if (current.length) commits.push(current);
      current = [];
    } else if (line.trim()) {
      current.push(line.trim());
    }
  }
  if (current.length) commits.push(current);
  return commits;
}

export function computeCoChangePairs(
  commits: string[][],
  options: { minCoChanges: number; minConfidence: number },
): CoChangePair[] {
  const fileCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const files of commits) {
    const unique = Array.from(new Set(files));
    for (const f of unique) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const [l, r] = unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
        const key = `${l}|${r}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const out: CoChangePair[] = [];
  for (const [key, coOccurrences] of pairCounts.entries()) {
    if (coOccurrences < options.minCoChanges) continue;
    const [left, right] = key.split('|');
    const union = (fileCounts.get(left) ?? 0) + (fileCounts.get(right) ?? 0) - coOccurrences;
    const confidence = union > 0 ? coOccurrences / union : 0;
    if (confidence < options.minConfidence) continue;
    out.push({ left, right, coOccurrences, confidence });
  }
  return out;
}

export async function inferCoChangeLinks(
  store: KnowledgeStore,
  options: CoChangeOptions,
): Promise<CoChangeReport> {
  const policy = getRetrievalPolicy().graphInference;
  const minCo = options.minCoChanges ?? policy.coChange.minCoChanges;
  const minConf = options.minConfidence ?? policy.coChange.minConfidence;
  const lookback = options.lookbackCommits ?? policy.coChange.lookbackCommits;

  const commits = options.commitsOverride
    ?? (await readGitCommits(options.cwd ?? process.cwd(), lookback));

  const pairs = computeCoChangePairs(commits, { minCoChanges: minCo, minConfidence: minConf });

  // Pre-fetch all project atoms once and index by evidence file path.
  const atoms = await store.listAtoms({ project: options.project, limit: 5000 });
  const byPath = new Map<string, KnowledgeAtom[]>();
  for (const atom of atoms) {
    for (const ev of atom.evidence) {
      if (ev.kind === 'file') {
        const list = byPath.get(ev.path) ?? [];
        list.push(atom);
        byPath.set(ev.path, list);
      }
    }
  }

  // Collect new edges first; sync per-atom at the end so each atom's
  // 'co_change' slice is replaced atomically.
  const newLinksByAtom = new Map<string, AtomLink[]>();
  for (const pair of pairs) {
    const leftAtoms = byPath.get(pair.left) ?? [];
    const rightAtoms = byPath.get(pair.right) ?? [];
    for (const la of leftAtoms) {
      for (const ra of rightAtoms) {
        if (la.id === ra.id) continue;
        pushLink(newLinksByAtom, la.id, ra.id, pair.confidence);
        pushLink(newLinksByAtom, ra.id, la.id, pair.confidence);
      }
    }
  }

  let edges = 0;
  for (const [atomId, links] of newLinksByAtom.entries()) {
    await syncAtomLinks(atomId, links, store, 'co_change');
    edges += links.length;
  }
  return { scannedCommits: commits.length, pairsConsidered: pairs.length, edgesEmitted: edges };
}

function pushLink(
  bucket: Map<string, AtomLink[]>,
  fromId: string,
  toId: string,
  confidence: number,
): void {
  const arr = bucket.get(fromId) ?? [];
  // Deduplicate (a,b) pairs that surface through multiple co-changing files.
  if (!arr.some((l) => l.toAtomId === toId)) {
    arr.push({ toAtomId: toId, kind: 'co_changes_with', confidence });
    bucket.set(fromId, arr);
  }
}
