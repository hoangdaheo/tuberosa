/**
 * Phase 5 — project-local compose template.
 *
 * Embedded as a string so the published `tuberosa` CLI doesn't need a separate
 * data file in `node_modules` (resolving package-relative paths is gnarly across
 * pnpm / yarn pnp / npm hoisting). Mirrors the production `docker-compose.yml`
 * with two changes: it runs `pnpm run migrate` against the user's checkout
 * instead of the prebuilt `dist/`, and it only brings up postgres + redis (no
 * `app` container) so the user can keep `pnpm run dev` in the loop.
 */
export function composeTemplate(params: {
  password: string;
  postgresPort: number;
  redisPort: number;
}): string {
  return [
    'services:',
    '  postgres:',
    '    image: pgvector/pgvector:pg16',
    '    environment:',
    '      POSTGRES_DB: tuberosa',
    '      POSTGRES_USER: tuberosa',
    `      POSTGRES_PASSWORD: ${params.password}`,
    '    ports:',
    `      - "127.0.0.1:${params.postgresPort}:5432"`,
    '    volumes:',
    '      - tuberosa-postgres:/var/lib/postgresql/data',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "pg_isready -U tuberosa -d tuberosa"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 10',
    '',
    '  redis:',
    '    image: redis:7-alpine',
    '    ports:',
    `      - "127.0.0.1:${params.redisPort}:6379"`,
    '    healthcheck:',
    '      test: ["CMD", "redis-cli", "ping"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 10',
    '',
    'volumes:',
    '  tuberosa-postgres:',
    '',
  ].join('\n');
}
