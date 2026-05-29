export type AtomType = 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
export type AtomTier = 'draft' | 'verified' | 'canonical';
export type AtomStatus = 'active' | 'legacy_archived' | 'superseded' | 'archived';
export type AtomProducer = 'agent_session' | 'user' | 'migration_llm';
export type AtomLinkKind = 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';

// Concern F — user-style preference layer.
// scope='user' atoms belong to a single human across all their projects; the
// `priority` discriminator drives conflict resolution against project conventions
// during retrieval.
export type AtomScope = 'project' | 'user';
export type StylePriority = 'personal_workflow' | 'coding_preference';

export type Evidence =
  | { kind: 'file'; path: string; lineStart?: number; lineEnd?: number; commitSha?: string }
  | { kind: 'commit'; sha: string; message?: string }
  | { kind: 'test'; path: string; testName: string }
  | { kind: 'url'; uri: string; fetchedAt: string }
  | { kind: 'prior_session'; sessionId: string; decisionId?: string };

export interface Trigger {
  errors?: string[];
  files?: string[];
  symbols?: string[];
  taskTypes?: string[];
  intentTags?: string[];
}

export interface Verification {
  command?: string;
  testRef?: { path: string; testName: string };
  assertion?: string;
}

export interface AtomLink {
  toAtomId: string;
  kind: AtomLinkKind;
  confidence: number;
}

export interface AtomAudit {
  producedBy: AtomProducer;
  producedAtSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeAtom {
  id: string;
  project: string;
  parentKnowledgeId?: string;

  claim: string;
  type: AtomType;
  evidence: Evidence[];
  trigger: Trigger;

  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];

  tier: AtomTier;
  reuseCount: number;
  lastReusedAt?: string;
  status: AtomStatus;
  audit: AtomAudit;

  scope: AtomScope;
  userId?: string;
  priority?: StylePriority;
  /**
   * Free-form metadata. Currently used by user-style atoms to flag low-evidence
   * inputs (e.g. `{ lowEvidence: true }`) so workbench reviewers can prioritise.
   */
  metadata?: Record<string, unknown>;
}

export interface KnowledgeAtomInput {
  /**
   * Optional explicit id, used by import flows that need to preserve the
   * source-bundle's identifier so subsequent merges and edge references stay
   * consistent. When omitted, the store generates a random UUID.
   */
  id?: string;
  project: string;
  parentKnowledgeId?: string;
  claim: string;
  type: AtomType;
  evidence: Evidence[];
  trigger: Trigger;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
  producedBy: AtomProducer;
  producedAtSessionId?: string;
  /**
   * Optional precomputed embedding of the atom's canonical text
   * (see atomEmbeddingText). When provided it is stored so future critic
   * dedup queries perform real cosine similarity. Optional so direct
   * createAtom callers/tests that don't supply it still compile.
   */
  embedding?: number[];

  // Concern F — user-style preference layer. Default scope is 'project'.
  scope?: AtomScope;
  userId?: string;
  priority?: StylePriority;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeAtomPatch {
  /** Export V2 — content fields, updated only on conflict take_imported / merged. */
  claim?: string;
  type?: AtomType;
  evidence?: Evidence[];
  trigger?: Trigger;
  tier?: AtomTier;
  status?: AtomStatus;
  reuseCount?: number;
  lastReusedAt?: string;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
}

export interface ListAtomsOptions {
  project?: string;
  tier?: AtomTier;
  status?: AtomStatus;
  parentKnowledgeId?: string;
  scope?: AtomScope;
  userId?: string;
  limit: number;
}
