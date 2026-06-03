export interface AppConfig {
  env: string;
  http: {
    port: number;
    /** HTTP bind host. Defaults to 127.0.0.1; set TUBEROSA_HTTP_HOST=0.0.0.0 to expose externally. */
    host: string;
    apiKey?: string;
    /** When true (default), requests from non-loopback addresses must present a valid API key even if apiKey is unset. */
    requireApiKeyForNonLoopback: boolean;
    maxRequestBytes: number;
  };
  storage: {
    store: 'postgres' | 'memory';
    cache: 'redis' | 'memory' | 'none';
    databaseUrl: string;
    redisUrl: string;
    autoMigrate: boolean;
  };
  model: {
    provider: 'hash' | 'openai' | 'local' | 'ollama';
    embeddingDimensions: number;
    openAiApiKey?: string;
    openAiEmbeddingModel: string;
    openAiRewriteModel?: string;
    openAiRerankModel?: string;
    openAiTimeoutMs: number;
    ollamaUrl?: string;
    ollamaRerankModel?: string;
    ollamaTimeoutMs?: number;
    /** Concern D — enable the stage-4 LLM critic. Defaults to whether the provider can judge. */
    llmCriticEnabled: boolean;
  };
  context: {
    mode?: 'compact' | 'layered';
    cacheTtlSeconds: number;
    deepContextBudget?: number;
  };
  ingest: {
    maxContentBytes: number;
  };
  backup: {
    dir: string;
    exportBaseDir: string;
    importBaseDir: string;
    intervalSeconds: number;
    startupDelaySeconds: number;
    retentionCount: number;
    retentionMaxAgeDays: number;
    writeThrough: boolean;
    writeThroughThrottleSeconds: number;
  };
  mirror: {
    enabled?: boolean;
    dir?: string;
    debounceMs: number;
  };
  atlas: {
    dir?: string;
    autoRegen?: boolean;
  };
  errorLog: {
    dir: string;
    maxBytes: number;
    autoCapture: boolean;
    captureClientErrors: boolean;
  };
  worktree: {
    /** Phase 5 — when true, the worktree provider runs as a 6th retrieval source. */
    enabled: boolean;
    /** Phase 5 — hard cap on files surfaced from the worktree per query. */
    maxFiles: number;
    /** Phase 5 — recency window for mtime-based file selection. */
    maxMtimeAgeHours: number;
  };
  archival: {
    /** Concern D — when true (default), the worker runs the atom archival sweep on a timer. */
    enabled: boolean;
    /** Concern D — hours between scheduled archival sweeps. */
    intervalHours: number;
  };
  graphInference: {
    /** Concern C1 — toggle for scheduled write-side graph inference jobs (co-change + stale-edge prune). */
    enabled: boolean;
  };
  userStyle: {
    /** Concern F — master switch for the user-style preference layer. Default true. Optional so older test config literals keep compiling. */
    enabled?: boolean;
    /** Concern F — when set, retrieval pulls user-style atoms for this user as a 7th candidate source. */
    userId?: string;
    /** Concern F — team knowledge layer identifier. Defaults to "default". Optional so existing test config literals keep compiling. */
    teamId?: string;
    /** Phase 2 — master switch for the convention candidate lane (team + project). Default true. Optional so older test config literals keep compiling. */
    conventionsEnabled?: boolean;
    /** Concern F — interval between scheduled user-correction clustering runs (hours). */
    clusterIntervalHours?: number;
    /** Concern F — feedback lookback window for the clusterer (days). */
    clusterWindowDays?: number;
    /** Concern F — minimum events per cluster before a learning proposal is created. */
    minClusterEvents?: number;
  };
  persistReplay: boolean;
  /** Concern C1 — project name the worker uses for its scheduled inference jobs. Skipped when unset. */
  defaultProject?: string;
  /** Concern C1 — cwd used for git history scans in scheduled jobs. Defaults to process.cwd(). */
  defaultCwd?: string;
}

export function loadConfig(): AppConfig {
  return {
    env: process.env.NODE_ENV ?? 'development',
    http: {
      port: Number(process.env.PORT ?? 3027),
      host: process.env.TUBEROSA_HTTP_HOST ?? '127.0.0.1',
      apiKey: process.env.TUBEROSA_API_KEY || undefined,
      requireApiKeyForNonLoopback: readBoolean(process.env.TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK, true),
      maxRequestBytes: envInt('TUBEROSA_MAX_REQUEST_BYTES', 10 * 1024 * 1024),
    },
    storage: {
      store: readEnum(process.env.TUBEROSA_STORE, ['postgres', 'memory'], 'postgres'),
      cache: readEnum(process.env.TUBEROSA_CACHE, ['redis', 'memory', 'none'], 'redis'),
      databaseUrl: process.env.DATABASE_URL ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa',
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
      autoMigrate: readBoolean(process.env.TUBEROSA_AUTO_MIGRATE, true),
    },
    model: {
      provider: readEnum(process.env.TUBEROSA_MODEL_PROVIDER, ['hash', 'openai', 'local', 'ollama'], process.env.OPENAI_API_KEY ? 'openai' : 'hash'),
      embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
      openAiApiKey: process.env.OPENAI_API_KEY || undefined,
      openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      openAiRewriteModel: process.env.OPENAI_REWRITE_MODEL || undefined,
      openAiRerankModel: process.env.OPENAI_RERANK_MODEL || undefined,
      openAiTimeoutMs: envInt('TUBEROSA_OPENAI_TIMEOUT_MS', 30_000),
      ollamaUrl: process.env.TUBEROSA_OLLAMA_URL || undefined,
      ollamaRerankModel: process.env.TUBEROSA_OLLAMA_RERANK_MODEL || undefined,
      ollamaTimeoutMs: process.env.TUBEROSA_OLLAMA_TIMEOUT_MS ? Number(process.env.TUBEROSA_OLLAMA_TIMEOUT_MS) : undefined,
      llmCriticEnabled: readBoolean(
        process.env.TUBEROSA_LLM_CRITIC_ENABLED,
        (process.env.TUBEROSA_MODEL_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'hash')) === 'openai',
      ),
    },
    context: {
      mode: readEnum(process.env.TUBEROSA_CONTEXT_MODE, ['compact', 'layered'] as Array<'compact' | 'layered'>, 'layered'),
      cacheTtlSeconds: Number(process.env.CONTEXT_CACHE_TTL_SECONDS ?? 300),
      deepContextBudget: Number(process.env.TUBEROSA_DEEP_CONTEXT_BUDGET ?? 60_000),
    },
    ingest: {
      maxContentBytes: envInt('TUBEROSA_MAX_INGEST_CONTENT_BYTES', 2 * 1024 * 1024),
    },
    backup: {
      dir: process.env.TUBEROSA_BACKUP_DIR ?? '.tuberosa/backups',
      exportBaseDir: process.env.TUBEROSA_EXPORT_BASE_DIR ?? '.tuberosa/exports',
      importBaseDir: process.env.TUBEROSA_IMPORT_BASE_DIR ?? '.tuberosa/imports',
      intervalSeconds: Number(process.env.TUBEROSA_BACKUP_INTERVAL_SECONDS ?? 60 * 60),
      startupDelaySeconds: Number(process.env.TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS ?? 60),
      retentionCount: Number(process.env.TUBEROSA_BACKUP_RETENTION_COUNT ?? 24),
      retentionMaxAgeDays: Number(process.env.TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS ?? 30),
      writeThrough: readBoolean(process.env.TUBEROSA_BACKUP_WRITE_THROUGH, false),
      writeThroughThrottleSeconds: Number(process.env.TUBEROSA_BACKUP_WRITE_THROUGH_THROTTLE_SECONDS ?? 10 * 60),
    },
    mirror: {
      enabled: readBoolean(process.env.TUBEROSA_PHYSICAL_MIRROR_ENABLED, false),
      dir: process.env.TUBEROSA_PHYSICAL_MIRROR_DIR ?? '.tuberosa/current',
      debounceMs: Number(process.env.TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS ?? 500),
    },
    atlas: {
      dir: process.env.TUBEROSA_ATLAS_DIR ?? '.tuberosa/atlas',
      autoRegen: readBoolean(process.env.TUBEROSA_ATLAS_AUTO_REGEN, true),
    },
    errorLog: {
      dir: process.env.TUBEROSA_ERROR_LOG_DIR ?? '.tuberosa/error-logs',
      maxBytes: Number(process.env.TUBEROSA_ERROR_LOG_MAX_BYTES ?? 256 * 1024),
      autoCapture: readBoolean(process.env.TUBEROSA_ERROR_LOG_AUTO_CAPTURE, true),
      captureClientErrors: readBoolean(process.env.TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS, false),
    },
    worktree: {
      enabled: readBoolean(process.env.TUBEROSA_WORKTREE_ENABLED, true),
      maxFiles: Number(process.env.TUBEROSA_WORKTREE_MAX_FILES ?? 50),
      maxMtimeAgeHours: Number(process.env.TUBEROSA_WORKTREE_MAX_MTIME_AGE_HOURS ?? 72),
    },
    archival: {
      enabled: readBoolean(process.env.TUBEROSA_ARCHIVAL_ENABLED, true),
      intervalHours: Number(process.env.TUBEROSA_ARCHIVAL_INTERVAL_HOURS ?? 24),
    },
    graphInference: {
      enabled: readBoolean(process.env.TUBEROSA_GRAPH_INFERENCE_ENABLED, true),
    },
    userStyle: {
      enabled: readBoolean(process.env.TUBEROSA_USER_STYLE_ENABLED, true),
      userId: process.env.TUBEROSA_USER_ID || undefined,
      teamId: process.env.TUBEROSA_TEAM_ID || 'default',
      conventionsEnabled: readBoolean(process.env.TUBEROSA_CONVENTIONS_ENABLED, true),
      clusterIntervalHours: Number(process.env.TUBEROSA_USER_STYLE_CLUSTER_INTERVAL_HOURS ?? 1),
      clusterWindowDays: Number(process.env.TUBEROSA_USER_STYLE_CLUSTER_WINDOW_DAYS ?? 30),
      minClusterEvents: Number(process.env.TUBEROSA_USER_STYLE_MIN_CLUSTER_EVENTS ?? 3),
    },
    persistReplay: readBoolean(process.env.TUBEROSA_PERSIST_REPLAY, false),
    defaultProject: process.env.TUBEROSA_DEFAULT_PROJECT || undefined,
    defaultCwd: process.env.TUBEROSA_DEFAULT_CWD || undefined,
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
