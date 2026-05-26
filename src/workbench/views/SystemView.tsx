import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { presentSystemStatus } from '../presenters/systemPresenter.js';
import type { WorkbenchSummary } from '../types.js';
import { Pill } from '../components/Pill.js';

export function SystemView({ summary, summaryVM }: { summary: WorkbenchSummary | null; summaryVM: SummaryViewModel | null }) {
  const items = presentSystemStatus(summary);
  return (
    <section class="system-view" data-testid="system-view">
      <h1>System</h1>
      <p class="muted">Health, setup, cache, provider, backups, and local operating state.</p>
      {summaryVM && <p class="system-line">{summaryVM.health.line}</p>}
      <div class="system-grid">
        {items.map((item) => (
          <article class="system-card" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <Pill kind={item.tone}>{item.tone}</Pill>
          </article>
        ))}
      </div>
    </section>
  );
}
