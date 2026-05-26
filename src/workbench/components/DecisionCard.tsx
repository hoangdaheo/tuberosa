import type { ReviewQueueItemView } from '../types.js';
import { Pill } from './Pill.js';

export function DecisionCard({ item }: { item: ReviewQueueItemView }) {
  return (
    <article class={`decision-card ${item.tone}`} data-testid={`decision-card-${item.type}`}>
      <div class="card-header">
        <div>
          <Pill kind={pillKind(item.tone)}>P{item.priority}</Pill>
          <h3>{item.title}</h3>
        </div>
        <Pill kind="muted">{item.type}</Pill>
      </div>
      <p>{item.summary}</p>
      <p class="small muted"><strong>Why it matters:</strong> {item.whyItMatters}</p>
      {item.evidence.length > 0 && (
        <ul class="evidence-list">
          {item.evidence.slice(0, 5).map((entry) => <li key={entry}>{entry}</li>)}
        </ul>
      )}
      <div class="queue-actions">
        <button class="primary">{item.primaryAction}</button>
        {item.secondaryActions.slice(0, 3).map((action) => <button key={action}>{action}</button>)}
      </div>
    </article>
  );
}

function pillKind(tone: ReviewQueueItemView['tone']): 'good' | 'warn' | 'bad' | 'accent' | 'muted' {
  if (tone === 'good') return 'good';
  if (tone === 'warn') return 'warn';
  if (tone === 'bad') return 'bad';
  if (tone === 'accent') return 'accent';
  return 'muted';
}
