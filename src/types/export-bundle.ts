import type {
  AtomLink,
  AtomStatus,
  AtomTier,
  AtomType,
  Evidence,
  KnowledgeAtom,
  Trigger,
  Verification,
} from './atoms.js';

/**
 * Concern E — manifest for a `.tuberosa-pack/` directory. Hashes in `integrity`
 * map relative file paths (e.g. `edges.jsonl`) to `sha256:<hex>`. The special
 * key `manifest_self` is computed last; importers can detect tampering by
 * recomputing the hash of the manifest with that key set to "pending".
 */
export interface BundleManifest {
  schemaVersion: number;
  project: string;
  generated: string;
  sourceCommit?: string;
  tuberosaVersion?: string;
  counts: { atoms: number; knowledge: number; edges: number; chunks: number };
  integrity: Record<string, string>;
  tierPolicy: { exportedTiers: AtomTier[]; excludedStatuses: AtomStatus[] };
  includesChunks: boolean;
  safetyRedactionVersion: string;
  notes?: string;
}

export interface AtomFrontmatter {
  id: string;
  revision: number;
  project: string;
  type: AtomType;
  tier: AtomTier;
  status: AtomStatus;
  trigger: Trigger;
  evidence: Evidence[];
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
  audit: {
    producedBy: string;
    producedAtSessionId?: string;
    createdAt: string;
    updatedAt: string;
  };
  /** Optional override. When absent, the Markdown body is the claim. */
  claim?: string;
}

export interface KnowledgeFrontmatter {
  id: string;
  project: string;
  itemType: 'wiki' | 'spec' | 'code_ref' | 'workflow' | 'rule' | 'conversation';
  title: string;
  labels: Array<{ type: string; value: string; weight?: number }>;
  references: Array<{ type: string; uri: string; lineStart?: number; lineEnd?: number }>;
  trustLevel: number;
  audit: { createdAt: string; updatedAt: string };
}

export interface BundleEdge {
  from: string;
  to: string;
  kind: 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';
  confidence: number;
  inferenceSource: 'migration' | 'semantic' | 'co_change' | 'refines_detector' | 'manual';
}

export interface AtomImportConflict {
  id: string;
  project: string;
  atomId: string;
  localSnapshot: KnowledgeAtom;
  importedSnapshot: AtomFrontmatter & { body: string };
  bundleSource: string;
  status:
    | 'open'
    | 'resolved_keep_local'
    | 'resolved_take_imported'
    | 'resolved_merged'
    | 'dismissed';
  resolutionNotes?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type AtomImportConflictAction =
  | 'keep_local'
  | 'take_imported'
  | 'merged'
  | 'dismissed';
