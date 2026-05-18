CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  root_path_hash text,
  remote_hash text,
  languages text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  uri text NOT NULL,
  title text,
  content_hash text NOT NULL,
  trust_level integer NOT NULL DEFAULT 50,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, uri, content_hash)
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  source_id uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  item_type text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  content text NOT NULL,
  status text NOT NULL DEFAULT 'approved',
  trust_level integer NOT NULL DEFAULT 50,
  freshness_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_type text NOT NULL,
  value text NOT NULL,
  normalized_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label_type, normalized_value)
);

CREATE TABLE IF NOT EXISTS knowledge_labels (
  knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
  label_id uuid REFERENCES labels(id) ON DELETE CASCADE,
  weight real NOT NULL DEFAULT 1,
  PRIMARY KEY (knowledge_id, label_id)
);

CREATE TABLE IF NOT EXISTS knowledge_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
  ref_type text NOT NULL,
  uri text NOT NULL,
  line_start integer,
  line_end integer,
  commit_sha text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  from_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  target_kind text NOT NULL,
  target_knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
  target_value text,
  confidence real NOT NULL DEFAULT 0.7,
  inferred boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_knowledge_id IS NOT NULL OR target_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  left_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  right_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  conflict_type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  shared_evidence text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (left_knowledge_id <> right_knowledge_id),
  UNIQUE (left_knowledge_id, right_knowledge_id, conflict_type)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  contextual_content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  embedding vector(1536),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(contextual_content, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS reflection_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL,
  content text NOT NULL,
  item_type text NOT NULL,
  trigger_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  suggested_labels jsonb NOT NULL DEFAULT '[]',
  duplicate_candidates jsonb NOT NULL DEFAULT '[]',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE IF NOT EXISTS context_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  query_fingerprint text NOT NULL,
  classified jsonb NOT NULL DEFAULT '{}',
  token_budget integer NOT NULL DEFAULT 4000,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid REFERENCES context_queries(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  confidence real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'proposed',
  pack jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  selected_at timestamptz,
  rejected_at timestamptz
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  feedback_type text NOT NULL,
  reason text,
  rejected_knowledge_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  cwd text,
  agent_name text,
  agent_tool text,
  status text NOT NULL DEFAULT 'active',
  initial_context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  outcome text,
  summary text,
  reflection_draft_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_context_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  decision text NOT NULL,
  reason text,
  rejected_knowledge_ids uuid[] NOT NULL DEFAULT '{}',
  retry_context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_project_status ON knowledge_items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_type ON knowledge_items(item_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_metadata ON knowledge_items USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_labels_type_norm ON labels(label_type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_knowledge_references_uri ON knowledge_references USING gin(uri gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_project_type ON knowledge_relations(project_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_from ON knowledge_relations(from_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target_knowledge ON knowledge_relations(target_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target_value ON knowledge_relations(target_kind, lower(target_value));
CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_project_status ON knowledge_conflicts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_left ON knowledge_conflicts(left_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_right ON knowledge_conflicts(right_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON knowledge_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON knowledge_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_context_queries_fingerprint ON context_queries(query_fingerprint);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_status ON agent_sessions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_session ON agent_context_decisions(session_id);
