import { demoMode } from '../state/store.js';

export function DemoToggle() {
  const mode = demoMode.value;
  return (
    <div style="display:flex;gap:4px;align-items:center;font-size:12px">
      <span class="pill" data-tone={mode === 'seeded' ? '' : 'warm'}>
        {mode}
      </span>
      <button
        class="ghost"
        style="padding:2px 8px;font-size:11px"
        onClick={() => {
          demoMode.value = mode === 'seeded' ? 'live' : 'seeded';
        }}
      >
        switch to {mode === 'seeded' ? 'live' : 'seeded'}
      </button>
    </div>
  );
}
