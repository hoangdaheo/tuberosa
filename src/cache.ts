import { createClient, type RedisClientType } from 'redis';
import type { AppConfig } from './config.js';

export interface Cache {
  getJson<T>(key: string): Promise<T | undefined>;
  setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

export async function createCache(config: AppConfig): Promise<Cache> {
  if (config.cache === 'none') {
    return new NullCache();
  }

  if (config.cache === 'memory') {
    return new MemoryCache();
  }

  const client = createClient({ url: config.redisUrl });
  client.on('error', (error) => {
    console.error('[redis]', error.message);
  });
  await client.connect();
  return new RedisCache(client as RedisClientType);
}

class RedisCache implements Cache {
  constructor(private readonly client: RedisClientType) {}

  async getJson<T>(key: string): Promise<T | undefined> {
    const value = await this.client.get(key);
    return value ? (JSON.parse(value) as T) : undefined;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const encoded = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, encoded, { EX: ttlSeconds });
      return;
    }

    await this.client.set(key, encoded);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit();
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
