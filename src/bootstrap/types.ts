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
  /**
   * Run the non-fatal convention-extraction stage. Defaults to enabled; the CLI
   * sets it `false` when `--no-conventions` is passed. Treated as "run unless
   * explicitly disabled" (`args.conventions !== false`).
   */
  conventions?: boolean;
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
  /**
   * Deterministic convention-extraction signal count assembled at bootstrap
   * time. The CLI cannot distill conventions without an agent, so this stage
   * only counts candidate signals and `nextActions` points the user at the
   * `tuberosa_bootstrap_handbook` agent tool. Absent when the stage is skipped
   * (`--no-conventions`) or fails (non-fatal — see `warnings`).
   */
  conventions?: { candidateSignalCount: number };
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
