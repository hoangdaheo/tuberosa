import { createClient, type RedisClientType } from 'redis';
import type { AppConfig } from './config.js';
import { CacheError } from './errors.js';

export interface Cache {
  getJson<T>(key: string): Promise<T | undefined>;
  setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

export async function createCache(config: AppConfig): Promise<Cache> {
  if (config.storage.cache === 'none') {
    return new NullCache();
  }

  if (config.storage.cache === 'memory') {
    return new MemoryCache();
  }

  const client = createClient({
    url: config.storage.redisUrl,
    socket: {
      reconnectStrategy: false,
    },
  });
  client.on('error', (error) => {
    console.error('[redis]', error.message);
  });
  try {
    await client.connect();
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    throw new CacheError('Redis cache connection failed.', error);
  }
  return new RedisCache(client as RedisClientType);
}

class RedisCache implements Cache {
  constructor(private readonly client: RedisClientType) {}

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : undefined;
    } catch (error) {
      throw new CacheError('Redis cache read failed.', error);
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const encoded = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, encoded, { EX: ttlSeconds });
        return;
      }

      await this.client.set(key, encoded);
    } catch (error) {
      throw new CacheError('Redis cache write failed.', error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      throw new CacheError('Redis cache delete failed.', error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (error) {
      throw new CacheError('Redis cache close failed.', error);
    }
  }
}

export class MemoryCache implements Cache {
  private readonly values = new Map<string, { expiresAt?: number; value: unknown }>();

  async getJson<T>(key: string): Promise<T | undefined> {
    const entry = this.values.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.values.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async close(): Promise<void> {}
}

class NullCache implements Cache {
  async getJson<T>(): Promise<T | undefined> {
    return undefined;
  }

  async setJson(): Promise<void> {}

  async del(): Promise<void> {}

  async close(): Promise<void> {}
}
