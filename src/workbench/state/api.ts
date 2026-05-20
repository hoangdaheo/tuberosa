const API_KEY_STORAGE = 'tuberosa.workbench.apiKey';
const PROJECT_STORAGE = 'tuberosa.workbench.project';
const LIMIT_STORAGE = 'tuberosa.workbench.limit';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(key: string): void {
  if (key) {
    localStorage.setItem(API_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(API_KEY_STORAGE);
  }
}

export function getProject(): string {
  return localStorage.getItem(PROJECT_STORAGE) ?? '';
}

export function setProject(project: string): void {
  if (project) {
    localStorage.setItem(PROJECT_STORAGE, project);
  } else {
    localStorage.removeItem(PROJECT_STORAGE);
  }
}

export function getLimit(): number {
  const raw = localStorage.getItem(LIMIT_STORAGE);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function setLimit(limit: number): void {
  localStorage.setItem(LIMIT_STORAGE, String(limit));
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = { 'accept': 'application/json' };
  const apiKey = getApiKey();
  if (apiKey) headers['x-tuberosa-api-key'] = apiKey;

  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url.toString(), init);
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const body = data as { error?: { message?: string; code?: string } } | undefined;
    const message = body?.error?.message ?? `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, body?.error?.code);
  }
  return data as T;
}
