import { toasts } from '../state/store.js';

export function Toasts() {
  return (
    <div class="toasts-root">
      {toasts.value.map((t) => (
        <div key={t.id} class="card fade-in" data-tone={t.tone}>
          <span class="pill" data-tone={t.tone === 'info' ? 'neutral' : t.tone}>
            {t.tone}
          </span>
          <span style="margin-left:8px">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
