import type { WorkbenchSummary } from '../types.js';
import { Pill } from '../components/Pill.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';
import { EmptyState } from '../components/EmptyState.js';

interface Props {
  summary: WorkbenchSummary | null;
}

export function QualityView({ summary }: Props) {
  if (!summary) {
    return (
      <div class="panel">
        <h2>Context quality review</h2>
        <p class="muted">Loading…</p>
      </div>
    );
  }
  const items = summary.contextQuality?.records ?? [];
  return (
    <div class="panel" data-testid="quality-view">
      <h2>Context quality review</h2>
      <p class="muted small">
        Agents and reviewers leave <GlossaryTerm termKey="context_decision">context decisions</GlossaryTerm> on
        each pack. Noisy / missing signals are surfaced here so you can ingest the missing material or fix the
        ranking.
      </p>
      {items.length === 0
        ? <EmptyState title="No quality feedback yet" hint="Once agents start running sessions you will see selected_but_noisy and missing_context records here." />
        : (
          <ul class="bare" data-testid="quality-list">
            {items.map((item) => (
              <li class="card" key={item.id}>
                <div class="card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div class="card-title">{item.reason ?? '(no reason given)'}</div>
                    <div class="small muted">pack {item.contextPackId ? <code>{item.contextPackId}</code> : '—'} · {new Date(item.createdAt).toLocaleString()}</div>
                  </div>
                  <Pill kind={feedbackKind(item.feedbackType)}>{item.feedbackType}</Pill>
                </div>
                {item.knowledgeIds && item.knowledgeIds.length > 0 && (
                  <div class="small muted">
                    Knowledge IDs:{' '}
                    {item.knowledgeIds.map((id, i) => <span key={id}>{i > 0 && ', '}<code>{id}</code></span>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      }
    </div>
  );
}

function feedbackKind(type: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (type === 'selected') return 'good';
  if (type.startsWith('missing')) return 'bad';
  if (type === 'rejected' || type === 'irrelevant' || type === 'stale') return 'bad';
  return 'warn';
}
