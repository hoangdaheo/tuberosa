import type { ReviewQueueFilter, WorkbenchSummary } from '../types.js';
import { presentReviewQueue } from '../presenters/reviewQueuePresenter.js';
import { navigate } from '../state/store.js';
import { DecisionCard } from '../components/DecisionCard.js';
import { EmptyState } from '../components/EmptyState.js';

interface Props {
  summary: WorkbenchSummary | null;
  filter?: ReviewQueueFilter;
}

export function ReviewView({ summary, filter = 'all' }: Props) {
  if (!summary) {
    return <section class="panel" data-testid="review-view"><h1>Decision queue</h1><p class="muted">Loading review work...</p></section>;
  }
  const view = presentReviewQueue(summary, filter);
  return (
    <section class="review-view" data-testid="review-view">
      <div class="section-heading">
        <p class="eyebrow">Review</p>
        <h1>Decision queue</h1>
        <p class="muted">One prioritized place for drafts, context feedback, gaps, proposals, conflicts, risky memories, errors, and maintenance.</p>
      </div>
      <nav class="filter-strip" aria-label="Review filters">
        {view.filters.map((entry) => (
          <button
            key={entry.key}
            class={entry.key === view.activeFilter ? 'active' : ''}
            data-testid={`review-filter-${entry.key}`}
            onClick={() => navigate({ view: 'review', filter: entry.key })}
          >
            {entry.label} <span>{entry.count}</span>
          </button>
        ))}
      </nav>
      <div class="decision-queue" data-testid="review-queue">
        {view.items.length === 0
          ? <EmptyState title={view.emptyTitle} hint={view.emptyHint} />
          : view.items.map((item) => <DecisionCard item={item} key={`${item.type}-${item.id}`} />)}
      </div>
    </section>
  );
}
