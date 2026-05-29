import type { KnowledgeItemType } from '../types.js';

export type SyncMode = 'git' | 'fs';
export type SyncTrigger = 'cli' | 'mcp' | 'git_hook';

export type SourceFileStatus = 'tracked' | 'changed' | 'missing' | 'archived' | 'ignored';

/** One durable row per file path — the ledger. */
export interface SourceFileRecord {
  id: string;
  project: string;
  path: string;
  contentHash: string | null;
  status: SourceFileStatus;
  lastSyncedSha: string | null;
  priorPaths: string[];
  knowledgeCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
}

/** A single file as seen on disk during inventory. */
export interface InventoryEntry {
  path: string;
  contentHash: string;
  sizeBytes: number;
}

export type IgnoreReason = 'gitignored' | 'excluded' | 'too_large' | 'binary';

export interface SyncPlan {
  project: string;
  repoPath: string;
  mode: SyncMode;
  fromSha?: string;
  toSha?: string;
  added: Array<{ path: string; sizeBytes: number; willIngestAs: KnowledgeItemType }>;
  changed: Array<{ path: string; oldHash: string; newHash: string; knowledgeIds: string[] }>;
  renamed: Array<{ from: string; to: string; similarity: number }>;
  deleted: Array<{ path: string; knowledgeIds: string[]; atomIds: string[]; chunkCount: number }>;
  ignored: Array<{ path: string; reason: IgnoreReason }>;
  summary: { added: number; changed: number; renamed: number; deleted: number; ignored: number };
  destructive: boolean;
}

export interface SyncRunRecord {
  id: string;
  project: string;
  mode: SyncMode;
  fromSha: string | null;
  toSha: string | null;
  plan: SyncPlan;
  applied: boolean;
  trigger: SyncTrigger;
  createdAt: string;
  appliedAt: string | null;
}

/** Result of applying a plan. */
export interface ApplyResult {
  ingested: number;
  reingested: number;
  repointed: number;
  archived: number;
  skipped: Array<{ path: string; reason: 'hash_mismatch' | 'missing_on_disk' }>;
}
