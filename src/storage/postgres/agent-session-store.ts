import type { Pool } from 'pg';
import { isPersistedKnowledgeId } from '../../util/uuid.js';
import type {
  AgentContextDecision,
  AgentSession,
  AgentSessionNote,
  FinishAgentSessionInput,
  ListRecordsOptions,
  RecordAgentContextDecisionInput,
} from '../../types.js';
import type { SessionReplayBundle } from '../../operations/session-replay.js';
import { ensureProject, filterPersistedKnowledgeIds, toIso } from './shared-helpers.js';

/**
 * Agent-session lifecycle persistence (sessions + context decisions + session
 * replays) extracted from `PostgresKnowledgeStore`. None of these methods
 * participate in `withTransaction`, so they run directly against the pool.
 */
export class PostgresAgentSessionStore {
  constructor(private readonly pool: Pool) {}

  async createAgentSession(input: {
    prompt: string;
    project?: string;
    cwd?: string;
    agentName?: string;
    agentTool?: string;
    initialContextPackId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSession> {
    const projectId = input.project ? await ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `
        INSERT INTO agent_sessions (
          project_id, prompt, cwd, agent_name, agent_tool,
          initial_context_pack_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, prompt, cwd, agent_name, agent_tool, status,
          initial_context_pack_id, outcome, summary, reflection_draft_ids,
          metadata, created_at, updated_at, finished_at
      `,
      [
        projectId,
        input.prompt,
        input.cwd ?? null,
        input.agentName ?? null,
        input.agentTool ?? null,
        input.initialContextPackId ?? null,
        input.metadata ?? {},
      ],
    );

    return mapAgentSessionRow(result.rows[0], input.project);
  }

  async listAgentSessions(options: ListRecordsOptions): Promise<AgentSession[]> {
    const result = await this.pool.query(
      `
        SELECT s.id, p.name AS project, s.prompt, s.cwd, s.agent_name, s.agent_tool,
          s.status, s.initial_context_pack_id, s.outcome, s.summary,
          s.reflection_draft_ids, s.metadata, s.created_at, s.updated_at, s.finished_at
        FROM agent_sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR s.status = $3)
        ORDER BY s.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map((row) => mapAgentSessionRow(row));
  }

  async getAgentSession(id: string): Promise<AgentSession | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        SELECT s.id, p.name AS project, s.prompt, s.cwd, s.agent_name, s.agent_tool,
          s.status, s.initial_context_pack_id, s.outcome, s.summary,
          s.reflection_draft_ids, s.metadata, s.created_at, s.updated_at, s.finished_at
        FROM agent_sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async recordAgentContextDecision(input: RecordAgentContextDecisionInput & {
    retryContextPackId?: string;
  }): Promise<AgentContextDecision> {
    const result = await this.pool.query(
      `
        INSERT INTO agent_context_decisions (
          session_id, context_pack_id, decision, reason, rejected_knowledge_ids,
          retry_context_pack_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, session_id, context_pack_id, decision, reason,
          rejected_knowledge_ids, retry_context_pack_id, metadata, created_at
      `,
      [
        input.sessionId,
        input.contextPackId ?? null,
        input.feedbackType,
        input.reason ?? null,
        // Phase 5 follow-up: agent_context_decisions.rejected_knowledge_ids is uuid[];
        // synthetic worktree ids cannot be persisted and would crash the cast.
        filterPersistedKnowledgeIds(input.rejectedKnowledgeIds),
        input.retryContextPackId ?? null,
        input.metadata ?? {},
      ],
    );
    await this.pool.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [input.sessionId]);

    return mapAgentContextDecisionRow(result.rows[0]);
  }

  async listAgentContextDecisions(options: { sessionId?: string; limit: number }): Promise<AgentContextDecision[]> {
    const result = await this.pool.query(
      `
        SELECT id, session_id, context_pack_id, decision, reason,
          rejected_knowledge_ids, retry_context_pack_id, metadata, created_at
        FROM agent_context_decisions
        WHERE ($2::uuid IS NULL OR session_id = $2)
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [options.limit, options.sessionId ?? null],
    );

    return result.rows.map(mapAgentContextDecisionRow);
  }

  async appendAgentSessionNote(input: {
    sessionId: string;
    note: AgentSessionNote;
  }): Promise<AgentSession | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_sessions s
        SET metadata = jsonb_set(
          COALESCE(s.metadata, '{}'::jsonb),
          '{notes}',
          COALESCE(s.metadata->'notes', '[]'::jsonb) || $2::jsonb,
          true
        ),
        updated_at = now()
        WHERE s.id = $1
        RETURNING s.id, s.prompt, s.cwd, s.agent_name, s.agent_tool, s.status,
          s.initial_context_pack_id, s.outcome, s.summary, s.reflection_draft_ids,
          s.metadata, s.created_at, s.updated_at, s.finished_at,
          (SELECT p.name FROM projects p WHERE p.id = s.project_id) AS project
      `,
      [input.sessionId, JSON.stringify([input.note])],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async writeSessionReplay(bundle: SessionReplayBundle): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_session_replays (
          session_id, recorded_at, classifier, source_candidates, fusion_order,
          rerank_deltas, adjustments, context_fit, pack, timings
        )
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
        ON CONFLICT (session_id) DO UPDATE SET
          recorded_at = EXCLUDED.recorded_at,
          classifier = EXCLUDED.classifier,
          source_candidates = EXCLUDED.source_candidates,
          fusion_order = EXCLUDED.fusion_order,
          rerank_deltas = EXCLUDED.rerank_deltas,
          adjustments = EXCLUDED.adjustments,
          context_fit = EXCLUDED.context_fit,
          pack = EXCLUDED.pack,
          timings = EXCLUDED.timings
      `,
      [
        bundle.sessionId,
        bundle.recordedAt ?? new Date().toISOString(),
        JSON.stringify(bundle.classifier),
        JSON.stringify(bundle.sourceCandidates),
        JSON.stringify(bundle.fusionOrder),
        JSON.stringify(bundle.rerankDeltas),
        JSON.stringify(bundle.adjustments),
        JSON.stringify(bundle.contextFit),
        JSON.stringify(bundle.pack),
        JSON.stringify(bundle.timings),
      ],
    );
  }

  async readSessionReplay(sessionId: string): Promise<SessionReplayBundle | null> {
    const result = await this.pool.query(
      `
        SELECT session_id, recorded_at, classifier, source_candidates, fusion_order,
          rerank_deltas, adjustments, context_fit, pack, timings
        FROM agent_session_replays
        WHERE session_id = $1
      `,
      [sessionId],
    );

    return result.rows[0] ? mapSessionReplayRow(result.rows[0]) : null;
  }

  async finishAgentSession(input: FinishAgentSessionInput & {
    reflectionDraftIds?: string[];
  }): Promise<AgentSession | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_sessions s
        SET status = 'finished',
          outcome = $2,
          summary = $3,
          reflection_draft_ids = s.reflection_draft_ids || $4::uuid[],
          metadata = s.metadata || $5::jsonb,
          updated_at = now(),
          finished_at = now()
        WHERE s.id = $1
        RETURNING s.id, s.prompt, s.cwd, s.agent_name, s.agent_tool, s.status,
          s.initial_context_pack_id, s.outcome, s.summary, s.reflection_draft_ids,
          s.metadata, s.created_at, s.updated_at, s.finished_at,
          (SELECT p.name FROM projects p WHERE p.id = s.project_id) AS project
      `,
      [
        input.sessionId,
        input.outcome,
        input.summary ?? null,
        input.reflectionDraftIds ?? [],
        input.metadata ?? {},
      ],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }
}

function mapAgentSessionRow(row: Record<string, unknown>, project?: string): AgentSession {
  return {
    id: String(row.id),
    project: project ?? (row.project ? String(row.project) : undefined),
    cwd: row.cwd ? String(row.cwd) : undefined,
    prompt: String(row.prompt),
    agentName: row.agent_name ? String(row.agent_name) : undefined,
    agentTool: row.agent_tool ? String(row.agent_tool) : undefined,
    status: row.status as AgentSession['status'],
    initialContextPackId: row.initial_context_pack_id ? String(row.initial_context_pack_id) : undefined,
    outcome: row.outcome ? row.outcome as AgentSession['outcome'] : undefined,
    summary: row.summary ? String(row.summary) : undefined,
    reflectionDraftIds: (row.reflection_draft_ids ?? []) as string[],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    finishedAt: row.finished_at ? toIso(row.finished_at) : undefined,
  };
}

function mapSessionReplayRow(row: Record<string, unknown>): SessionReplayBundle {
  return {
    sessionId: String(row.session_id),
    recordedAt: row.recorded_at ? toIso(row.recorded_at) : undefined,
    classifier: (row.classifier ?? {}) as Record<string, unknown>,
    sourceCandidates: (row.source_candidates ?? {}) as SessionReplayBundle['sourceCandidates'],
    fusionOrder: (row.fusion_order ?? []) as SessionReplayBundle['fusionOrder'],
    rerankDeltas: (row.rerank_deltas ?? []) as SessionReplayBundle['rerankDeltas'],
    adjustments: (row.adjustments ?? []) as SessionReplayBundle['adjustments'],
    contextFit: row.context_fit as SessionReplayBundle['contextFit'],
    pack: row.pack as SessionReplayBundle['pack'],
    timings: row.timings as SessionReplayBundle['timings'],
  };
}

function mapAgentContextDecisionRow(row: Record<string, unknown>): AgentContextDecision {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    contextPackId: row.context_pack_id ? String(row.context_pack_id) : undefined,
    decision: row.decision as AgentContextDecision['decision'],
    reason: row.reason ? String(row.reason) : undefined,
    rejectedKnowledgeIds: (row.rejected_knowledge_ids ?? []) as string[],
    retryContextPackId: row.retry_context_pack_id ? String(row.retry_context_pack_id) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
  };
}
