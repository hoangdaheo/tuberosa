import type { PipelineStageView } from '../types.js';

export function PipelineRail({ stages }: { stages: PipelineStageView[] }) {
  return (
    <section class="visual-panel" data-testid="pipeline-rail">
      <div class="section-heading">
        <h2>Pipeline</h2>
        <p class="muted small">How Tuberosa turned the task into a context decision.</p>
      </div>
      <ol class="pipeline-rail">
        {stages.map((stage, index) => (
          <li class={stage.status} key={stage.key}>
            <span class="pipeline-index">{index + 1}</span>
            <strong>{stage.label}</strong>
            <span>{stage.detail}</span>
            {stage.count !== undefined && <em>{stage.count}</em>}
          </li>
        ))}
      </ol>
    </section>
  );
}
