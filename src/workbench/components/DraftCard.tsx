import type { DraftViewModel } from '../presenters/draftPresenter.js';
import { Pill } from './Pill.js';

interface Props {
  draft: DraftViewModel;
  expanded: boolean;
  onToggle: () => void;
}

export function DraftCard({ draft, expanded, onToggle }: Props) {
  const verdictKind = draft.recommendationSummary?.verdict
    ? verdictPillKind(draft.recommendationSummary.verdict)
    : 'muted';
  return (
    <div class="card" data-testid="draft-card" data-draft-id={draft.id}>
      <div class="card-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          <button class="ghost" onClick={onToggle} style={{ padding: 0, textAlign: 'left' }} aria-expanded={expanded}>
            <div class="card-title truncate" title={draft.headline}>{expanded ? '▾' : '▸'} {draft.headline}</div>
          </button>
          <div class="small muted" style={{ marginTop: 4 }}>{draft.oneLineSummary}</div>
        </div>
        <div class="row" style={{ flexShrink: 0 }}>
          <Pill kind="muted">{draft.itemTypeLabel}</Pill>
          {draft.recommendationSummary && (
            <Pill kind={verdictKind} title={draft.recommendationSummary.rationale}>
              {verdictLabel(draft.recommendationSummary.verdict)}
            </Pill>
          )}
        </div>
      </div>
      <div class="small muted">{draft.whereItCameFrom.label} · {draft.age}</div>
    </div>
  );
}

export function verdictPillKind(v: 'approve' | 'needs_changes' | 'reject'): 'good' | 'warn' | 'bad' {
  if (v === 'approve') return 'good';
  if (v === 'reject') return 'bad';
  return 'warn';
}

export function verdictLabel(v: 'approve' | 'needs_changes' | 'reject'): string {
  if (v === 'approve') return 'Recommend approve';
  if (v === 'reject') return 'Recommend reject';
  return 'Needs changes';
}
