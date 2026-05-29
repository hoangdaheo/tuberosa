import type { SyncMode, SyncPlan } from './types.js';

export interface ChangeSet {
  project: string;
  repoPath: string;
  mode: SyncMode;
  fromSha?: string;
  toSha?: string;
  added: SyncPlan['added'];
  changed: SyncPlan['changed'];
  renamed: SyncPlan['renamed'];
  deleted: SyncPlan['deleted'];
  ignored: SyncPlan['ignored'];
}

export function buildPlan(changes: ChangeSet): SyncPlan {
  return {
    project: changes.project,
    repoPath: changes.repoPath,
    mode: changes.mode,
    fromSha: changes.fromSha,
    toSha: changes.toSha,
    added: changes.added,
    changed: changes.changed,
    renamed: changes.renamed,
    deleted: changes.deleted,
    ignored: changes.ignored,
    summary: {
      added: changes.added.length,
      changed: changes.changed.length,
      renamed: changes.renamed.length,
      deleted: changes.deleted.length,
      ignored: changes.ignored.length,
    },
    destructive: changes.deleted.length > 0,
  };
}
