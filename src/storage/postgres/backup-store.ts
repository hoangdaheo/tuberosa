import type { Pool, PoolClient } from 'pg';
import { StoreError } from '../../errors.js';
import type { BackupExportData, BackupTableData, BackupTableName } from '../../types.js';

interface BackupTableDefinition {
  name: BackupTableName;
  columns: string[];
  selectSql: string;
  casts?: Record<string, string>;
}

const BACKUP_TABLES: BackupTableDefinition[] = [
  {
    name: 'projects',
    columns: ['id', 'name', 'root_path_hash', 'remote_hash', 'languages', 'status', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, name, root_path_hash, remote_hash, languages, status, metadata, created_at, updated_at FROM projects ORDER BY created_at, id',
  },
  {
    name: 'knowledge_sources',
    columns: ['id', 'project_id', 'source_type', 'uri', 'title', 'content_hash', 'trust_level', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, source_type, uri, title, content_hash, trust_level, metadata, created_at, updated_at FROM knowledge_sources ORDER BY created_at, id',
  },
  {
    name: 'knowledge_items',
    columns: ['id', 'project_id', 'source_id', 'item_type', 'title', 'summary', 'content', 'status', 'trust_level', 'freshness_at', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, source_id, item_type, title, summary, content, status, trust_level, freshness_at, metadata, created_at, updated_at FROM knowledge_items ORDER BY created_at, id',
  },
  {
    name: 'labels',
    columns: ['id', 'label_type', 'value', 'normalized_value', 'created_at'],
    selectSql: 'SELECT id, label_type, value, normalized_value, created_at FROM labels ORDER BY created_at, id',
  },
  {
    name: 'knowledge_labels',
    columns: ['knowledge_id', 'label_id', 'weight'],
    selectSql: 'SELECT knowledge_id, label_id, weight FROM knowledge_labels ORDER BY knowledge_id, label_id',
  },
  {
    name: 'knowledge_references',
    columns: ['id', 'knowledge_id', 'ref_type', 'uri', 'line_start', 'line_end', 'commit_sha', 'metadata', 'created_at'],
    selectSql: 'SELECT id, knowledge_id, ref_type, uri, line_start, line_end, commit_sha, metadata, created_at FROM knowledge_references ORDER BY created_at, id',
  },
  {
    name: 'knowledge_relations',
    columns: ['id', 'project_id', 'from_knowledge_id', 'relation_type', 'target_kind', 'target_knowledge_id', 'target_value', 'confidence', 'inferred', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, from_knowledge_id, relation_type, target_kind, target_knowledge_id, target_value, confidence, inferred, metadata, created_at, updated_at FROM knowledge_relations ORDER BY created_at, id',
  },
  {
    name: 'knowledge_conflicts',
    columns: ['id', 'project_id', 'left_knowledge_id', 'right_knowledge_id', 'conflict_type', 'status', 'shared_evidence', 'reason', 'metadata', 'created_at', 'updated_at', 'resolved_at'],
    selectSql: 'SELECT id, project_id, left_knowledge_id, right_knowledge_id, conflict_type, status, shared_evidence, reason, metadata, created_at, updated_at, resolved_at FROM knowledge_conflicts ORDER BY created_at, id',
  },
  {
    name: 'knowledge_chunks',
    columns: ['id', 'knowledge_id', 'project_id', 'chunk_index', 'content', 'contextual_content', 'token_estimate', 'embedding', 'metadata', 'created_at'],
    selectSql: 'SELECT id, knowledge_id, project_id, chunk_index, content, contextual_content, token_estimate, embedding::text AS embedding, metadata, created_at FROM knowledge_chunks ORDER BY created_at, id',
    casts: { embedding: 'vector' },
  },
  {
    name: 'reflection_drafts',
    columns: ['id', 'project_id', 'title', 'summary', 'content', 'item_type', 'trigger_type', 'status', 'suggested_labels', 'duplicate_candidates', 'metadata', 'created_at', 'reviewed_at'],
    selectSql: 'SELECT id, project_id, title, summary, content, item_type, trigger_type, status, suggested_labels, duplicate_candidates, metadata, created_at, reviewed_at FROM reflection_drafts ORDER BY created_at, id',
  },
  {
    name: 'context_queries',
    columns: ['id', 'project_id', 'prompt', 'query_fingerprint', 'classified', 'token_budget', 'created_at'],
    selectSql: 'SELECT id, project_id, prompt, query_fingerprint, classified, token_budget, created_at FROM context_queries ORDER BY created_at, id',
  },
  {
    name: 'context_packs',
    columns: ['id', 'query_id', 'project_id', 'confidence', 'status', 'pack', 'created_at', 'selected_at', 'rejected_at'],
    selectSql: 'SELECT id, query_id, project_id, confidence, status, pack, created_at, selected_at, rejected_at FROM context_packs ORDER BY created_at, id',
  },
  {
    name: 'feedback_events',
    columns: ['id', 'context_pack_id', 'project_id', 'feedback_type', 'reason', 'rejected_knowledge_ids', 'metadata', 'created_at'],
    selectSql: 'SELECT id, context_pack_id, project_id, feedback_type, reason, rejected_knowledge_ids, metadata, created_at FROM feedback_events ORDER BY created_at, id',
  },
  {
    name: 'agent_sessions',
    columns: ['id', 'project_id', 'prompt', 'cwd', 'agent_name', 'agent_tool', 'status', 'initial_context_pack_id', 'outcome', 'summary', 'reflection_draft_ids', 'metadata', 'created_at', 'updated_at', 'finished_at'],
    selectSql: 'SELECT id, project_id, prompt, cwd, agent_name, agent_tool, status, initial_context_pack_id, outcome, summary, reflection_draft_ids, metadata, created_at, updated_at, finished_at FROM agent_sessions ORDER BY created_at, id',
  },
  {
    name: 'agent_context_decisions',
    columns: ['id', 'session_id', 'context_pack_id', 'decision', 'reason', 'rejected_knowledge_ids', 'retry_context_pack_id', 'metadata', 'created_at'],
    selectSql: 'SELECT id, session_id, context_pack_id, decision, reason, rejected_knowledge_ids, retry_context_pack_id, metadata, created_at FROM agent_context_decisions ORDER BY created_at, id',
  },
  {
    name: 'knowledge_gaps',
    columns: ['id', 'project_id', 'status', 'source_feedback_id', 'source_session_id', 'context_pack_id', 'prompt', 'classified', 'missing_signals', 'reason', 'metadata', 'created_at', 'updated_at', 'reviewed_at'],
    selectSql: 'SELECT id, project_id, status, source_feedback_id, source_session_id, context_pack_id, prompt, classified, missing_signals, reason, metadata, created_at, updated_at, reviewed_at FROM knowledge_gaps ORDER BY created_at, id',
  },
  {
    name: 'learning_proposals',
    columns: ['id', 'project_id', 'proposal_type', 'status', 'source_feedback_id', 'source_session_id', 'context_pack_id', 'affected_knowledge_id', 'candidate_knowledge_id', 'reason', 'evidence', 'metadata', 'created_at', 'updated_at', 'reviewed_at'],
    selectSql: 'SELECT id, project_id, proposal_type, status, source_feedback_id, source_session_id, context_pack_id, affected_knowledge_id, candidate_knowledge_id, reason, evidence, metadata, created_at, updated_at, reviewed_at FROM learning_proposals ORDER BY created_at, id',
  },
];

export class PostgresBackupStore {
  constructor(private readonly pool: Pool) {}

  async exportBackup(): Promise<BackupExportData> {
    const tables = await Promise.all(BACKUP_TABLES.map(async (table) => {
      const result = await this.pool.query<Record<string, unknown>>(table.selectSql);
      return {
        name: table.name,
        rows: result.rows.map(normalizeBackupRow),
      };
    }));

    return { tables };
  }

  async restoreBackup(input: { tables: BackupTableData[]; dryRun?: boolean; replace?: boolean }): Promise<Record<BackupTableName, number>> {
    const counts = Object.fromEntries(
      BACKUP_TABLES.map((table) => [table.name, tableRows(input.tables, table.name).length]),
    ) as Record<BackupTableName, number>;

    if (input.dryRun) {
      return counts;
    }

    if (!input.replace) {
      throw new StoreError('Backup restore requires replace=true unless dryRun=true.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE ${BACKUP_TABLES.map((table) => table.name).join(', ')} RESTART IDENTITY CASCADE`);

      for (const table of BACKUP_TABLES) {
        for (const row of tableRows(input.tables, table.name)) {
          await insertBackupRow(client, table, row);
        }
      }

      await client.query('COMMIT');
      return counts;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalizeBackupRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

function tableRows(tables: BackupTableData[], name: BackupTableName): Array<Record<string, unknown>> {
  return tables.find((table) => table.name === name)?.rows ?? [];
}

async function insertBackupRow(
  client: PoolClient,
  table: BackupTableDefinition,
  row: Record<string, unknown>,
): Promise<void> {
  const placeholders = table.columns.map((column, index) => {
    const cast = table.casts?.[column];
    return cast ? `$${index + 1}::${cast}` : `$${index + 1}`;
  });
  const values = table.columns.map((column) => row[column] ?? null);

  await client.query(
    `
      INSERT INTO ${table.name} (${table.columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `,
    values,
  );
}
