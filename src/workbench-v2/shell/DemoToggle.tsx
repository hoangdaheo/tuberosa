import { demoMode } from '../state/store.js';

export function DemoToggle() {
  const mode = demoMode.value;
  return (
    <div class="demo-toggle">
      <span class="pill" data-tone={mode === 'seeded' ? 'neutral' : 'warm'}>
        {mode}
      </span>
      <button
        class="ghost"
        onClick={() => {
          demoMode.value = mode === 'seeded' ? 'live' : 'seeded';
        }}
      >
        → {mode === 'seeded' ? 'live' : 'seeded'}
      </button>
    </div>
  );
}
