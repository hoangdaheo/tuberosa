export type ViewName = 'start' | 'sessions' | 'session' | 'review' | 'knowledge' | 'playbooks' | 'system';
export type ReviewFilter = 'all' | 'drafts' | 'quality' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' | 'maintenance';

export interface WorkbenchRoute {
  view: ViewName;
  sessionId?: string;
  filter?: ReviewFilter;
  playbookId?: string;
}

export type RouteTarget =
  | ViewName
  | { view: ViewName; sessionId?: string; filter?: ReviewFilter; playbookId?: string };

export const DEFAULT_WORKBENCH_ROUTE: WorkbenchRoute = { view: 'start' };

const REVIEW_FILTERS = new Set<ReviewFilter>([
  'all',
  'drafts',
  'quality',
  'gaps',
  'proposals',
  'conflicts',
  'risky',
  'errors',
  'maintenance',
]);

export function parseWorkbenchHash(hashValue: string): WorkbenchRoute {
  const raw = hashValue.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const view = parts[0];

  if (!view) return DEFAULT_WORKBENCH_ROUTE;
  if (view === 'start') return { view: 'start' };
  if (view === 'sessions') return { view: 'sessions' };
  if (view === 'session' && parts[1]) return { view: 'session', sessionId: decodeURIComponent(parts[1]) };
  if (view === 'review') {
    const filter = readReviewFilter(queryPart);
    return filter ? { view: 'review', filter } : { view: 'review' };
  }
  if (view === 'knowledge') return { view: 'knowledge' };
  if (view === 'playbooks') {
    return parts[1] ? { view: 'playbooks', playbookId: decodeURIComponent(parts[1]) } : { view: 'playbooks' };
  }
  if (view === 'system') return { view: 'system' };

  return DEFAULT_WORKBENCH_ROUTE;
}

export function routeToHash(route: WorkbenchRoute): string {
  switch (route.view) {
    case 'start':
      return '#/start';
    case 'sessions':
      return '#/sessions';
    case 'session':
      return route.sessionId ? `#/session/${encodeURIComponent(route.sessionId)}` : '#/sessions';
    case 'review':
      return route.filter ? `#/review?filter=${route.filter}` : '#/review';
    case 'knowledge':
      return '#/knowledge';
    case 'playbooks':
      return route.playbookId ? `#/playbooks/${encodeURIComponent(route.playbookId)}` : '#/playbooks';
    case 'system':
      return '#/system';
  }
}

export function normalizeRouteTarget(target: RouteTarget): WorkbenchRoute {
  if (typeof target === 'string') return { view: target };
  return target;
}

function readReviewFilter(queryPart: string | undefined): ReviewFilter | undefined {
  if (!queryPart) return undefined;
  const params = new URLSearchParams(queryPart);
  const raw = params.get('filter');
  return raw && REVIEW_FILTERS.has(raw as ReviewFilter) ? (raw as ReviewFilter) : undefined;
}
