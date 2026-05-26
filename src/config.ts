export interface AppConfig {
  env: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  apiKey?: string;
  /** HTTP bind host. Defaults to 127.0.0.1; set TUBEROSA_HTTP_HOST=0.0.0.0 to expose externally. */
  httpHost: string;
  /** When true (default), requests from non-loopback addresses must present a valid API key even if apiKey is unset. */
  requireApiKeyForNonLoopback: boolean;
  store: 'postgres' | 'memory';
  cache: 'redis' | 'memory' | 'none';
  autoMigrate: boolean;
  modelProvider: 'hash' | 'openai' | 'local' | 'ollama';
  embeddingDimensions: number;
  openAiApiKey?: string;
  openAiEmbeddingModel: string;
  openAiRewriteModel?: string;
  openAiRerankModel?: string;
  ollamaUrl?: string;
  ollamaRerankModel?: string;
  ollamaTimeoutMs?: number;
  contextCacheTtlSeconds: number;
  contextMode?: 'compact' | 'layered';
  deepContextBudget?: number;
  maxRequestBytes: number;
  maxIngestContentBytes: number;
  backupDir: string;
  backupIntervalSeconds: number;
  backupStartupDelaySeconds: number;
  backupRetentionCount: number;
  backupRetentionMaxAgeDays: number;
  backupWriteThrough: boolean;
  backupWriteThroughThrottleSeconds: number;
  physicalMirrorEnabled?: boolean;
  physicalMirrorDir?: string;
  physicalMirrorDebounceMs: number;
  errorLogDir: string;
  errorLogMaxBytes: number;
  errorLogAutoCapture: boolean;
  errorLogCaptureClientErrors: boolean;
  persistReplay: boolean;
  /** Phase 5 — when true, the worktree provider runs as a 6th retrieval source. */
  worktreeEnabled: boolean;
  /** Phase 5 — hard cap on files surfaced from the worktree per query. */
  worktreeMaxFiles: number;
  /** Phase 5 — recency window for mtime-based file selection. */
  worktreeMaxMtimeAgeHours: number;
}

export function loadConfig(): AppConfig {
  return {
    env: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3027),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    apiKey: process.env.TUBEROSA_API_KEY || undefined,
    httpHost: process.env.TUBEROSA_HTTP_HOST ?? '127.0.0.1',
    requireApiKeyForNonLoopback: readBoolean(process.env.TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK, true),
    store: readEnum(process.env.TUBEROSA_STORE, ['postgres', 'memory'], 'postgres'),
    cache: readEnum(process.env.TUBEROSA_CACHE, ['redis', 'memory', 'none'], 'redis'),
    autoMigrate: readBoolean(process.env.TUBEROSA_AUTO_MIGRATE, true),
    modelProvider: readEnum(process.env.TUBEROSA_MODEL_PROVIDER, ['hash', 'openai', 'local', 'ollama'], process.env.OPENAI_API_KEY ? 'openai' : 'hash'),
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    openAiRewriteModel: process.env.OPENAI_REWRITE_MODEL || undefined,
    openAiRerankModel: process.env.OPENAI_RERANK_MODEL || undefined,
    ollamaUrl: process.env.TUBEROSA_OLLAMA_URL || undefined,
    ollamaRerankModel: process.env.TUBEROSA_OLLAMA_RERANK_MODEL || undefined,
    ollamaTimeoutMs: process.env.TUBEROSA_OLLAMA_TIMEOUT_MS ? Number(process.env.TUBEROSA_OLLAMA_TIMEOUT_MS) : undefined,
    contextCacheTtlSeconds: Number(process.env.CONTEXT_CACHE_TTL_SECONDS ?? 300),
    contextMode: readEnum(process.env.TUBEROSA_CONTEXT_MODE, ['compact', 'layered'] as Array<'compact' | 'layered'>, 'layered'),
    deepContextBudget: Number(process.env.TUBEROSA_DEEP_CONTEXT_BUDGET ?? 60_000),
    maxRequestBytes: Number(process.env.TUBEROSA_MAX_REQUEST_BYTES ?? 10 * 1024 * 1024),
    maxIngestContentBytes: Number(process.env.TUBEROSA_MAX_INGEST_CONTENT_BYTES ?? 2 * 1024 * 1024),
    backupDir: process.env.TUBEROSA_BACKUP_DIR ?? '.tuberosa/backups',
    backupIntervalSeconds: Number(process.env.TUBEROSA_BACKUP_INTERVAL_SECONDS ?? 60 * 60),
    backupStartupDelaySeconds: Number(process.env.TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS ?? 60),
    backupRetentionCount: Number(process.env.TUBEROSA_BACKUP_RETENTION_COUNT ?? 24),
    backupRetentionMaxAgeDays: Number(process.env.TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS ?? 30),
    backupWriteThrough: readBoolean(process.env.TUBEROSA_BACKUP_WRITE_THROUGH, false),
    backupWriteThroughThrottleSeconds: Number(process.env.TUBEROSA_BACKUP_WRITE_THROUGH_THROTTLE_SECONDS ?? 10 * 60),
    physicalMirrorEnabled: readBoolean(process.env.TUBEROSA_PHYSICAL_MIRROR_ENABLED, false),
    physicalMirrorDir: process.env.TUBEROSA_PHYSICAL_MIRROR_DIR ?? '.tuberosa/current',
    physicalMirrorDebounceMs: Number(process.env.TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS ?? 500),
    errorLogDir: process.env.TUBEROSA_ERROR_LOG_DIR ?? '.tuberosa/error-logs',
    errorLogMaxBytes: Number(process.env.TUBEROSA_ERROR_LOG_MAX_BYTES ?? 256 * 1024),
    errorLogAutoCapture: readBoolean(process.env.TUBEROSA_ERROR_LOG_AUTO_CAPTURE, true),
    errorLogCaptureClientErrors: readBoolean(process.env.TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS, false),
    persistReplay: readBoolean(process.env.TUBEROSA_PERSIST_REPLAY, false),
    worktreeEnabled: readBoolean(process.env.TUBEROSA_WORKTREE_ENABLED, true),
    worktreeMaxFiles: Number(process.env.TUBEROSA_WORKTREE_MAX_FILES ?? 50),
    worktreeMaxMtimeAgeHours: Number(process.env.TUBEROSA_WORKTREE_MAX_MTIME_AGE_HOURS ?? 72),
  };
}

function readEnum<T extends string>(value: string | undefined, allowed: T[], fallback: T): T {
  if (value && allowed.includes(value as T)) {
    return value as T;
  }

  return fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
