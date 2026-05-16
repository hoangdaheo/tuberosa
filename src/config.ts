export interface AppConfig {
  env: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  apiKey?: string;
  store: 'postgres' | 'memory';
  cache: 'redis' | 'memory' | 'none';
  modelProvider: 'hash' | 'openai';
  embeddingDimensions: number;
  openAiApiKey?: string;
  openAiEmbeddingModel: string;
  openAiRerankModel?: string;
  contextCacheTtlSeconds: number;
  maxRequestBytes: number;
  maxIngestContentBytes: number;
  backupDir: string;
}

export function loadConfig(): AppConfig {
  return {
    env: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3027),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    apiKey: process.env.TUBEROSA_API_KEY || undefined,
    store: readEnum(process.env.TUBEROSA_STORE, ['postgres', 'memory'], 'postgres'),
    cache: readEnum(process.env.TUBEROSA_CACHE, ['redis', 'memory', 'none'], 'redis'),
    modelProvider: readEnum(process.env.TUBEROSA_MODEL_PROVIDER, ['hash', 'openai'], process.env.OPENAI_API_KEY ? 'openai' : 'hash'),
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
    openAiApiKey: process.env.OPENAI_API_KEY || undefined,
    openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    openAiRerankModel: process.env.OPENAI_RERANK_MODEL || undefined,
    contextCacheTtlSeconds: Number(process.env.CONTEXT_CACHE_TTL_SECONDS ?? 300),
    maxRequestBytes: Number(process.env.TUBEROSA_MAX_REQUEST_BYTES ?? 10 * 1024 * 1024),
    maxIngestContentBytes: Number(process.env.TUBEROSA_MAX_INGEST_CONTENT_BYTES ?? 2 * 1024 * 1024),
    backupDir: process.env.TUBEROSA_BACKUP_DIR ?? '.tuberosa/backups',
  };
}

function readEnum<T extends string>(value: string | undefined, allowed: T[], fallback: T): T {
  if (value && allowed.includes(value as T)) {
    return value as T;
  }

  return fallback;
}
