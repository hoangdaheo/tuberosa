export type AtomType = 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
export type AtomTier = 'draft' | 'verified' | 'canonical';
export type AtomStatus = 'active' | 'legacy_archived' | 'superseded' | 'archived';
export type AtomProducer = 'agent_session' | 'user' | 'migration_llm';
export type AtomLinkKind = 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';

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
}

export interface KnowledgeAtomPatch {
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
  limit: number;
}
