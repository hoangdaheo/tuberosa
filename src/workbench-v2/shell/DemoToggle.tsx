import { useEffect } from 'preact/hooks';
import { connection, dataSource, probeConnection } from '../state/store.js';

export function DemoToggle() {
  const mode = dataSource.value;
  const conn = connection.value;
  useEffect(() => {
    void probeConnection();
  }, []);
  const dotColor = conn === 'connected' ? 'var(--good)' : conn === 'offline' ? 'var(--bad)' : 'var(--paper-3)';
  const connLabel =
    conn === 'connected' ? 'connected' : conn === 'offline' ? 'offline — showing seeded' : 'checking…';
  return (
    <div class="demo-toggle" title="Seeded uses bundled demo data. Live reads this checkout's running Tuberosa server.">
      <span class="pill" data-tone={mode === 'seeded' ? 'neutral' : 'warm'}>{mode}</span>
      <button
        class="ghost"
        onClick={() => {
          dataSource.value = mode === 'seeded' ? 'live' : 'seeded';
        }}
      >
        → {mode === 'seeded' ? 'live' : 'seeded'}
      </button>
      <span style="display:inline-flex;align-items:center;gap:6px;margin-left:10px;color:var(--paper-3);font-size:var(--fs-overline)">
        <span aria-hidden="true" style={`width:8px;height:8px;border-radius:50%;background:${dotColor}`} />
        {connLabel}
      </span>
    </div>
  );
}
