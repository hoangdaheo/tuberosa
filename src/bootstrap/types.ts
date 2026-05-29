import type { SourceFileStatus, SyncPlan, ApplyResult } from '../source-sync/types.js';
import type { AtomGraphDensity } from '../operations/atom-graph-density.js';

/** Focused first-run health snapshot, read directly from store primitives. */
export interface BootstrapHealth {
  sourceCounts: Record<SourceFileStatus, number>;
  tombstones: number;
  openImportConflicts: number;
  maintenanceItems: number;
  gaps: number;
}

export interface BootstrapRunArgs {
  project: string;
  repoPath: string;
  /** ISO timestamp; injected so the service stays deterministic in tests. */
  generatedAt: string;
  export?: boolean;
  deep?: boolean;
  /** Optional explicit output dir for `--export`; resolved safely against exportBaseDir. */
  out?: string;
}

export interface BootstrapReport {
  project: string;
  repoPath: string;
  sync: { planId: string; summary: SyncPlan['summary']; applied: ApplyResult };
  atlas?: { inputHash: string; files: { name: string; bytes: number }[] };
  health: BootstrapHealth;
  deep?: {
    coChangeEdgesEmitted?: number;
    graphDensity?: AtomGraphDensity;
    warnings: string[];
  };
  export?: {
    out: string;
    atoms: number;
    knowledge: number;
    edges: number;
    chunks: number;
    areas: number;
  };
  warnings: string[];
  nextActions: string[];
}
