CREATE TABLE IF NOT EXISTS agent_session_replays (
  session_id UUID PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  classifier JSONB NOT NULL,
  source_candidates JSONB NOT NULL,
  fusion_order JSONB NOT NULL,
  rerank_deltas JSONB NOT NULL,
  adjustments JSONB NOT NULL,
  context_fit JSONB NOT NULL,
  pack JSONB NOT NULL,
  timings JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_session_replays_recorded_at
  ON agent_session_replays (recorded_at DESC);
