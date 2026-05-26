import { signal } from '@preact/signals';
import {
  DEFAULT_WORKBENCH_ROUTE,
  normalizeRouteTarget,
  parseWorkbenchHash,
  routeToHash,
  type RouteTarget,
  type WorkbenchRoute,
} from './routes.js';

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

export type { RouteTarget, WorkbenchRoute };

export const currentRoute = signal<WorkbenchRoute>(readHashRoute());

export function ensureDefaultRoute(): void {
  const route = readHashRoute();
  const expected = routeToHash(route);
  if (window.location.hash !== expected) {
    window.history.replaceState(null, '', expected);
  }
}

export function navigate(target: RouteTarget): void {
  const route = normalizeRouteTarget(target);
  const nextHash = routeToHash(route);
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
  currentRoute.value = route;
}

function readHashRoute(): WorkbenchRoute {
  return parseWorkbenchHash(window.location.hash || routeToHash(DEFAULT_WORKBENCH_ROUTE));
}

window.addEventListener('hashchange', () => {
  currentRoute.value = readHashRoute();
});
