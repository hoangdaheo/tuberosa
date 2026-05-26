import { toasts } from '../state/store.js';

export function Toasts() {
  return (
    <div style="position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:50">
      {toasts.value.map((t) => (
        <div
          key={t.id}
          class="card fade-in"
          data-tone={t.tone}
          style={`min-width:240px;border-color:var(--${t.tone === 'bad' ? 'bad' : t.tone === 'good' ? 'good' : 'line'})`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
