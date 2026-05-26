import type { ChapterId } from '../types.js';

export interface Route {
  chapter: ChapterId;
  graphNodeId?: string;
  sessionId?: string;
}

const VALID: ReadonlySet<ChapterId> = new Set<ChapterId>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

export function parseHash(hash: string): Route {
  const m = /^#\/ch(\d+)(?:\/(node|session)\/([^/?#]+))?/.exec(hash || '');
  if (!m) return { chapter: 1 };
  const n = Number(m[1]) as ChapterId;
  if (!VALID.has(n)) return { chapter: 1 };
  const kind = m[2];
  const value = m[3] ? decodeURIComponent(m[3]) : undefined;
  if (kind === 'node') return { chapter: n, graphNodeId: value };
  if (kind === 'session') return { chapter: n, sessionId: value };
  return { chapter: n };
}

export function routeToHash(route: Route): string {
  if (route.graphNodeId) return `#/ch${route.chapter}/node/${encodeURIComponent(route.graphNodeId)}`;
  if (route.sessionId) return `#/ch${route.chapter}/session/${encodeURIComponent(route.sessionId)}`;
  return `#/ch${route.chapter}`;
}
