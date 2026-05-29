import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { IngestionService } from '../ingest/service.js';
import { inferItemTypeFromPath } from '../ingest/service.js';
import type { SyncMode, SyncPlan, SyncTrigger, ApplyResult } from './types.js';
import { DEFAULT_SYNC_POLICY, classifyPath, type SyncPolicy } from './policy.js';
import { walkInventory, hashContent } from './fs-inventory.js';
import { isGitRepo, gitHeadSha, gitLsFiles, gitDiffSince } from './git-inventory.js';
import { buildPlan, type ChangeSet } from './plan.js';
import { applyPlan } from './apply.js';

/** Minimal atlas regenerator surface — the real AtlasService satisfies it. */
export interface AtlasRegenerator {
  regenerate(args: { project: string; repoPath: string; generatedAt: string; write: boolean }): Promise<unknown>;
}

export interface SourceSyncServiceOptions {
  store: KnowledgeStore;
  ingestion: IngestionService;
  policy?: SyncPolicy;
  /** When set, the atlas is regenerated (non-fatally) at the end of every apply. */
  atlas?: AtlasRegenerator;
  /** Defaults to true when an atlas regenerator is provided. */
  atlasAutoRegen?: boolean;
}

export interface SyncArgs {
  project: string;
  repoPath: string;
  trigger: SyncTrigger;
}

export interface ApplyArgs {
  planId: string;
  allowDestructive: boolean;
}

/** Best-effort source path for an atom: first non-empty trigger file, else first file evidence. */
function atomSourcePath(atom: KnowledgeAtom): string | undefined {
  const triggered = atom.trigger.files?.find((f) => f.length > 0);
  if (triggered) return triggered;
  for (const ev of atom.evidence) {
    if (ev.kind === 'file' && ev.path) return ev.path;
  }
  return undefined;
}

export class SourceSyncService {
  private readonly store: KnowledgeStore;
  private readonly ingestion: IngestionService;
  private readonly policy: SyncPolicy;
  private readonly atlas?: AtlasRegenerator;
  private readonly atlasAutoRegen: boolean;

  constructor(opts: SourceSyncServiceOptions) {
    this.store = opts.store;
    this.ingestion = opts.ingestion;
    this.policy = opts.policy ?? DEFAULT_SYNC_POLICY;
    this.atlas = opts.atlas;
    this.atlasAutoRegen = opts.atlasAutoRegen ?? true;
  }

  async sync(args: SyncArgs): Promise<{ planId: string; plan: SyncPlan }> {
    const mode: SyncMode = isGitRepo(args.repoPath) ? 'git' : 'fs';
    const ledger = await this.store.listSourceFiles({ project: args.project, limit: 100_000 });
    const ledgerByPath = new Map(ledger.map((row) => [row.path, row]));

    // Build the on-disk inventory (path → {hash, size}), using git ls-files when available.
    const inventory = new Map<string, { contentHash: string; sizeBytes: number }>();
    const ignored: SyncPlan['ignored'] = [];
    if (mode === 'git') {
      for (const rel of gitLsFiles(args.repoPath)) {
        const size = (await stat(join(args.repoPath, rel))).size;
        const cls = classifyPath(rel, size, this.policy);
        if (!cls.include) {
          ignored.push({ path: rel, reason: cls.reason! });
          continue;
        }
        const buf = await readFile(join(args.repoPath, rel));
        inventory.set(rel, { contentHash: hashContent(buf), sizeBytes: size });
      }
    } else {
      const walked = await walkInventory(args.repoPath, this.policy);
      for (const entry of walked.entries) {
        inventory.set(entry.path, { contentHash: entry.contentHash, sizeBytes: entry.sizeBytes });
      }
      ignored.push(...walked.ignored);
    }

    const added: SyncPlan['added'] = [];
    const changed: SyncPlan['changed'] = [];
    for (const [path, info] of inventory) {
      const prior = ledgerByPath.get(path);
      if (!prior || prior.status === 'archived') {
        added.push({ path, sizeBytes: info.sizeBytes, willIngestAs: inferItemTypeFromPath(path) });
      } else if (prior.contentHash !== info.contentHash) {
        const linked = await this.store.listKnowledgeBySourcePath({ project: args.project, path });
        changed.push({ path, oldHash: prior.contentHash ?? '', newHash: info.contentHash, knowledgeIds: linked.map((k) => k.id) });
      }
    }

    // Deletions: ledger rows that are tracked/changed but absent from the inventory.
    const deleted: SyncPlan['deleted'] = [];
    for (const row of ledger) {
      if (row.status === 'archived' || row.status === 'ignored') {
        continue;
      }
      if (!inventory.has(row.path)) {
        const linked = await this.store.listKnowledgeBySourcePath({ project: args.project, path: row.path });
        deleted.push({ path: row.path, knowledgeIds: linked.map((k) => k.id), atomIds: [], chunkCount: 0 });
      }
    }

    // Rename detection via git diff (only when we have a baseline sha).
    const renamed: SyncPlan['renamed'] = [];
    const baseSha = ledger.find((row) => row.lastSyncedSha)?.lastSyncedSha ?? null;
    if (mode === 'git' && baseSha) {
      try {
        const diff = gitDiffSince(args.repoPath, baseSha);
        for (const rename of diff.renamed) {
          // Convert a detected rename into a re-point, removing the false add+delete pair.
          const addIdx = added.findIndex((entry) => entry.path === rename.to);
          if (addIdx >= 0) {
            added.splice(addIdx, 1);
          }
          const delIdx = deleted.findIndex((entry) => entry.path === rename.from);
          if (delIdx >= 0) {
            deleted.splice(delIdx, 1);
          }
          renamed.push(rename);
        }
      } catch {
        // baseline unreachable (history rewritten) — fall back to add/delete classification.
      }
    }

    // Link atoms to deleted paths so apply can tombstone them (P0 §5 step 4). Done once, only
    // when there are deletions, by matching each atom's source path against the deleted set.
    if (deleted.length > 0) {
      const atoms = await this.store.listAtoms({ project: args.project, limit: 100_000 });
      const atomsByPath = new Map<string, string[]>();
      for (const atom of atoms) {
        if (atom.status === 'archived') continue;
        const p = atomSourcePath(atom);
        if (!p) continue;
        const list = atomsByPath.get(p) ?? [];
        list.push(atom.id);
        atomsByPath.set(p, list);
      }
      for (const del of deleted) {
        del.atomIds = atomsByPath.get(del.path) ?? [];
      }
    }

    const toSha = mode === 'git' ? gitHeadSha(args.repoPath) : undefined;
    const changes: ChangeSet = {
      project: args.project,
      repoPath: args.repoPath,
      mode,
      fromSha: baseSha ?? undefined,
      toSha,
      added,
      changed,
      renamed,
      deleted,
      ignored,
    };
    const plan = buildPlan(changes);
    const run = await this.store.createSyncRun({
      project: args.project,
      mode,
      plan,
      trigger: args.trigger,
      fromSha: baseSha,
      toSha: toSha ?? null,
    });
    return { planId: run.id, plan };
  }

  async apply(args: ApplyArgs): Promise<ApplyResult> {
    const run = await this.store.getSyncRun(args.planId);
    if (!run) {
      throw new Error(`sync run ${args.planId} not found`);
    }
    // Additive ops (add/change/rename) always apply. Deletions archive only when explicitly
    // allowed; otherwise applyPlan defers them and we queue them for review. This is the
    // structural form of the "no silent destructive cleanup" invariant — and it ensures a mixed
    // add+delete commit still ingests the additions instead of aborting the whole sync.
    const result = await applyPlan({
      store: this.store,
      ingestion: this.ingestion,
      plan: run.plan,
      syncRunId: run.id,
      allowDestructive: args.allowDestructive,
      readFile: (path) => readFile(join(run.plan.repoPath, path), 'utf8'),
    });
    await this.store.markSyncRunApplied(run.id);

    if (result.deferredDeletions.length > 0) {
      await this.queuePendingDeletions(run.plan.repoPath, run.id, result.deferredDeletions);
    }

    if (this.atlas && this.atlasAutoRegen) {
      try {
        await this.atlas.regenerate({
          project: run.plan.project,
          repoPath: run.plan.repoPath,
          generatedAt: new Date().toISOString(),
          write: true,
        });
      } catch (err) {
        // Atlas is derived, never authoritative — a failed regen must not fail the sync.
        process.stderr.write(`[atlas] regenerate after sync failed (non-fatal): ${(err as Error).message}\n`);
      }
    }

    return result;
  }

  /**
   * Append deferred deletions to `.tuberosa/pending-sync.json` (deduped by path) so the git hook
   * and CLI never archive silently — the queue is the human/agent review surface for cleanup.
   * Best-effort: a write failure must not fail the sync.
   */
  private async queuePendingDeletions(
    repoPath: string,
    planId: string,
    deletions: ApplyResult['deferredDeletions'],
  ): Promise<void> {
    interface PendingDeletion { path: string; knowledgeIds: string[]; planId: string; detectedAt: string }
    const dir = join(repoPath, '.tuberosa');
    const file = join(dir, 'pending-sync.json');
    try {
      const byPath = new Map<string, PendingDeletion>();
      try {
        const existing = JSON.parse(await readFile(file, 'utf8')) as { deferredDeletions?: PendingDeletion[] };
        for (const entry of existing.deferredDeletions ?? []) {
          if (entry?.path) byPath.set(entry.path, entry);
        }
      } catch {
        // No prior queue (or unreadable) — start fresh.
      }
      const detectedAt = new Date().toISOString();
      for (const del of deletions) {
        byPath.set(del.path, { path: del.path, knowledgeIds: del.knowledgeIds, planId, detectedAt });
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, `${JSON.stringify({ deferredDeletions: [...byPath.values()] }, null, 2)}\n`, 'utf8');
    } catch (err) {
      process.stderr.write(`[source-sync] failed to write pending-sync queue (non-fatal): ${(err as Error).message}\n`);
    }
  }
}
