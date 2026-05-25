import { signal } from '@preact/signals';

export type ToastKind = 'info' | 'good' | 'bad';
export interface Toast { id: number; kind: ToastKind; message: string; }

export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function pushToast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, kind, message }];
  if (durationMs > 0) {
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, durationMs);
  }
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export type ViewName = 'overview' | 'catchup' | 'session' | 'quality' | 'memory' | 'guide';
export type MemoryTabName = 'drafts' | 'knowledge' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' | 'maintenance';

export interface WorkbenchRoute {
  view: ViewName;
  memoryTab: MemoryTabName;
}

export type RouteTarget = ViewName | { view: ViewName; memoryTab?: MemoryTabName };

const DEFAULT_ROUTE: WorkbenchRoute = { view: 'overview', memoryTab: 'drafts' };

export const currentRoute = signal<WorkbenchRoute>(readHashRoute());

export function ensureDefaultRoute(): void {
  const route = readHashRoute();
  const expected = routeToHash(route);
  if (window.location.hash !== expected) {
    window.history.replaceState(null, '', expected);
  }
}

function readHashRoute(): WorkbenchRoute {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const [viewPart, memoryTabPart] = hash.split('/');
  const view = parseView(viewPart);
  if (!view) {
    return DEFAULT_ROUTE;
  }
  if (view === 'memory' && memoryTabPart && !parseMemoryTab(memoryTabPart)) {
    return DEFAULT_ROUTE;
  }

  return {
    view,
    memoryTab: view === 'memory' ? parseMemoryTab(memoryTabPart) ?? 'drafts' : 'drafts',
  };
}

function parseView(value: string | undefined): ViewName | undefined {
  if (value === 'overview' || value === 'catchup' || value === 'session' || value === 'quality' || value === 'memory' || value === 'guide') {
    return value;
  }
  return undefined;
}

function parseMemoryTab(value: string | undefined): MemoryTabName | undefined {
  if (
    value === 'drafts'
    || value === 'knowledge'
    || value === 'gaps'
    || value === 'proposals'
    || value === 'conflicts'
    || value === 'risky'
    || value === 'errors'
    || value === 'maintenance'
  ) {
    return value;
  }
  return undefined;
}

export function navigate(target: RouteTarget, memoryTab?: MemoryTabName): void {
  const route = normalizeTarget(target, memoryTab);
  const nextHash = routeToHash(route);
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
  currentRoute.value = route;
}

function routeToHash(route: WorkbenchRoute): string {
  return route.view === 'memory' ? `#/memory/${route.memoryTab}` : `#/${route.view}`;
}

function normalizeTarget(target: RouteTarget, memoryTab?: MemoryTabName): WorkbenchRoute {
  if (typeof target === 'string') {
    return { view: target, memoryTab: target === 'memory' ? memoryTab ?? 'drafts' : currentRoute.value.memoryTab };
  }
  return { view: target.view, memoryTab: target.view === 'memory' ? target.memoryTab ?? 'drafts' : currentRoute.value.memoryTab };
}

window.addEventListener('hashchange', () => {
  currentRoute.value = readHashRoute();
});
