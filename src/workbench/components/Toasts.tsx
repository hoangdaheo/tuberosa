import { toasts, dismissToast } from '../state/store.js';

export function Toasts() {
  const list = toasts.value;
  return (
    <>
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`} role="status" onClick={() => dismissToast(t.id)}>
          {t.message}
        </div>
      ))}
    </>
  );
}
