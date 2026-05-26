import { pipelineSteps, type Step, type StageState } from './pipeline-flow-vm.js';

export { pipelineSteps };
export type { Step, StageState };

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
    <ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
      {steps.map((s) => (
        <li key={s.id}>
          <button
            class="card"
            onClick={() => onSelect?.(s.id)}
            style={`width:100%;text-align:left;cursor:pointer;display:flex;gap:12px;align-items:flex-start;border-color:${selected === s.id ? 'var(--accent)' : 'var(--line)'};opacity:${s.state === 'skipped' ? 0.55 : 1}`}
          >
            <div style="flex:1">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <strong>{s.title}</strong>
                <span
                  class="pill"
                  data-tone={s.state === 'skipped' ? 'warm' : s.state === 'failed' ? 'bad' : ''}
                >
                  {s.state}
                  {s.ms ? ` · ${s.ms}ms` : ''}
                </span>
              </div>
              <p style="margin:6px 0 0;color:var(--fg-muted);font-size:14px">{s.blurb}</p>
            </div>
          </button>
        </li>
      ))}
    </ol>
  );
}
