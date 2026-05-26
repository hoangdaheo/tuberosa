import { apiKey, pushToast } from '../state/store.js';

export class ApiError extends Error {
  constructor(
    msg: string,
    public status: number,
    public code?: string,
  ) {
    super(msg);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = new Headers(init.headers ?? {});
  headers.set('accept', 'application/json');
  if (apiKey.value) headers.set('x-tuberosa-api-key', apiKey.value);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const body = data as { error?: { message?: string; code?: string } } | undefined;
    const message = body?.error?.message ?? `Request failed: ${res.status}`;
    pushToast(message, 'bad');
    throw new ApiError(message, res.status, body?.error?.code);
  }
  return data as T;
}
