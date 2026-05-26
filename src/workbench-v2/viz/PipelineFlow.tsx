import { pipelineSteps, type Step, type StageState } from './pipeline-flow-vm.js';

export { pipelineSteps };
export type { Step, StageState };

const STATE_TONE: Record<StageState, string> = {
  pending: 'neutral',
  active: '',
  done: 'good',
  skipped: 'warm',
  failed: 'bad',
};

export function PipelineFlow({
  steps,
  onSelect,
  selected,
}: {
  steps: Step[];
  onSelect?: (id: string) => void;
  selected?: string;
}) {
  return (
    <ol
      class="pipeline-flow"
      style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px"
    >
      {steps.map((s, idx) => (
        <li key={s.id}>
          <button
            class="card"
            data-selected={selected === s.id ? 'true' : undefined}
            onClick={() => onSelect?.(s.id)}
            style={`padding:12px 14px;opacity:${s.state === 'skipped' ? 0.55 : 1}`}
          >
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
              <div style="display:flex;align-items:baseline;gap:10px;min-width:0">
                <span
                  style="font-family:var(--font-display);font-size:14px;color:var(--paper-3);font-variant-numeric:tabular-nums;flex:none"
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <strong style="font-family:var(--font-sans);font-weight:600;font-size:14px;letter-spacing:-0.005em">
                  {s.title.replace(/^\d+\s*·\s*/, '')}
                </strong>
              </div>
              <span class="pill" data-tone={STATE_TONE[s.state]} style="flex:none">
                {s.state}
                {s.ms ? ` · ${s.ms}ms` : ''}
              </span>
            </div>
            <p
              style="margin:6px 0 0 30px;color:var(--paper-2);font-size:var(--fs-small);line-height:1.5"
            >
              {s.blurb}
            </p>
          </button>
        </li>
      ))}
    </ol>
  );
}
