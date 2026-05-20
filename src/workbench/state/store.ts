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

export type ViewName = 'session' | 'quality' | 'memory' | 'guide';

export const currentView = signal<ViewName>(readHashView());

function readHashView(): ViewName {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === 'session' || hash === 'quality' || hash === 'memory' || hash === 'guide') {
    return hash;
  }
  return 'session';
}

export function navigate(view: ViewName): void {
  if (window.location.hash !== `#/${view}`) {
    window.location.hash = `#/${view}`;
  }
  currentView.value = view;
}

window.addEventListener('hashchange', () => {
  currentView.value = readHashView();
});
