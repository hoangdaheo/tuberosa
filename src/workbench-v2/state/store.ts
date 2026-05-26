import { signal } from '@preact/signals';
import { parseHash, routeToHash, type Route } from './routes.js';

export const route = signal<Route>(
  parseHash(typeof window !== 'undefined' ? window.location.hash : ''),
);
export const demoMode = signal<'seeded' | 'live'>('seeded');
export const apiKey = signal<string>(
  typeof localStorage !== 'undefined' ? localStorage.getItem('tuberosa.v2.apiKey') ?? '' : '',
);
export const currentProject = signal<string>('acme-billing');
export const tour = signal<{ playing: boolean; index: number }>({ playing: false, index: 0 });
export const toasts = signal<Array<{ id: number; tone: 'info' | 'bad' | 'good'; text: string }>>([]);

let toastSeq = 0;
export function pushToast(text: string, tone: 'info' | 'bad' | 'good' = 'info'): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, tone, text }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 4500);
}

export function setRoute(next: Route, replace = false): void {
  route.value = next;
  const hash = routeToHash(next);
  if (typeof history === 'undefined') return;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
}

export function setApiKey(v: string): void {
  apiKey.value = v;
  if (typeof localStorage === 'undefined') return;
  if (v) localStorage.setItem('tuberosa.v2.apiKey', v);
  else localStorage.removeItem('tuberosa.v2.apiKey');
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = parseHash(window.location.hash);
  });
}
