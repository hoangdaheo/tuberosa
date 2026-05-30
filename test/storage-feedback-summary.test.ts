import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import test from 'node:test';
import { ok } from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { runMigrations } from '../src/storage/migrations.js';

const POSTGRES_URL = process.env.TUBEROSA_INTEGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa';

test('getFeedbackSummaries tolerates worktree:<sha> ids stored inside pack sections', async (t) => {
  const available = await postgresAvailable();
  if (!available.ok) {
    t.skip(available.reason);
    return;
  }

  const migrationPool = new Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 1000 });
  await runMigrations(migrationPool);
  await migrationPool.end();

  const store = new PostgresKnowledgeStore(POSTGRES_URL);
  const project = `feedback-summary-${randomUUID()}`;
  const pool = (store as unknown as { pool: Pool }).pool;
  let knowledgeId = '';

  try {
    const client = await pool.connect();
    try {
      const projectInsert = await client.query<{ id: string }>(
        'INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id',
        [project],
      );
      const projectId = projectInsert.rows[0]!.id;

      const knowledgeInsert = await client.query<{ id: string }>(
        `INSERT INTO knowledge_items (project_id, item_type, title, summary, content, status)
         VALUES ($1, 'wiki', 't', 's', 'c', 'approved')
         RETURNING id`,
        [projectId],
      );
      knowledgeId = knowledgeInsert.rows[0]!.id;
      const worktreeId = `worktree:${'a'.repeat(64)}`;

      const packInsert = await client.query<{ id: string }>(
        `INSERT INTO context_packs (project_id, pack)
         VALUES ($1, $2::jsonb)
         RETURNING id`,
        [
          projectId,
          JSON.stringify({
            sections: [
              {
                name: 'essential',
                items: [
                  { knowledgeId, title: 'real item' },
                  { knowledgeId: worktreeId, title: 'worktree item' },
                ],
              },
            ],
          }),
        ],
      );
      const packId = packInsert.rows[0]!.id;

      await client.query(
        `INSERT INTO feedback_events (project_id, context_pack_id, feedback_type, rejected_knowledge_ids)
         VALUES ($1, $2, 'selected', '{}'::uuid[])`,
        [projectId, packId],
      );
    } finally {
      client.release();
    }

    const summaries = await store.getFeedbackSummaries([knowledgeId], { project });
    ok(summaries instanceof Map, 'returns a Map without throwing on mixed ids');
    ok(summaries.has(knowledgeId), 'returns a summary for the real uuid item');
  } finally {
    await store.close();
  }
});

async function postgresAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = new URL(POSTGRES_URL);
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : 5432;
  const tcp = await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
  if (!tcp) {
    return { ok: false, reason: `Postgres unavailable at ${POSTGRES_URL}` };
  }

  const pool = new Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 750, max: 1 });
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Postgres probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await pool.end().catch(() => {});
  }
}
