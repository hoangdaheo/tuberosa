import { Socket } from 'node:net';
import { Pool } from 'pg';
import { runMigrations } from '../../src/storage/migrations.js';

export const POSTGRES_URL = process.env.TUBEROSA_INTEGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa';

export async function postgresAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tcp = await tcpAvailable(POSTGRES_URL, 5432, 'Postgres');
  if (!tcp.ok) return tcp;

  const pool = new Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 750, max: 1 });
  try {
    await withTimeout(pool.query('SELECT 1'), 1000, 'Postgres probe timed out');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Postgres unavailable at ${POSTGRES_URL}: ${errorMessage(error)}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function ensurePostgresMigrated(): Promise<void> {
  const pool = new Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 1000 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function tcpAvailable(
  connectionUrl: string,
  defaultPort: number,
  service: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = new URL(connectionUrl);
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : defaultPort;

  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: `${service} unavailable at ${connectionUrl}: connection timed out` }));
    socket.once('error', (error) => finish({ ok: false, reason: `${service} unavailable at ${connectionUrl}: ${error.message}` }));
    socket.connect(port, host);
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
