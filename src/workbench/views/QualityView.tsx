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
              <li class="card" key={item.feedback.id}>
                <div class="card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div class="card-title">{item.feedback.reason ?? item.contextPack?.prompt ?? item.session?.prompt ?? '(no reason given)'}</div>
                    <div class="small muted">
                      pack {item.feedback.contextPackId ? <code>{item.feedback.contextPackId}</code> : '-'} · {new Date(item.feedback.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <Pill kind={feedbackKind(item.feedback.feedbackType)}>{item.feedback.feedbackType}</Pill>
                </div>
                {item.missingSignals.length > 0 && <QualityLine label="Missing signals" values={item.missingSignals} />}
                {item.adjacentItems.length > 0 && <QualityLine label="Noisy adjacent items" values={item.adjacentItems.map((entry) => entry.title)} />}
                {item.openKnowledgeGaps.length > 0 && <QualityLine label="Open gaps" values={item.openKnowledgeGaps.map((gap) => gap.reason ?? gap.id)} />}
                {item.openLearningProposals.length > 0 && <QualityLine label="Open proposals" values={item.openLearningProposals.map((proposal) => `${proposal.proposalType}: ${proposal.reason}`)} />}
                {item.suggestedReviewActions.length > 0 && <QualityLine label="Suggested actions" values={item.suggestedReviewActions} />}
              </li>
            ))}
          </ul>
        )
      }
    </div>
  );
}

function QualityLine({ label, values }: { label: string; values: string[] }) {
  return (
    <div class="small muted quality-line">
      <strong>{label}:</strong>{' '}
      {values.slice(0, 4).map((value, i) => <span key={`${label}-${i}`}>{i > 0 && ' · '}{value}</span>)}
      {values.length > 4 && <span> · +{values.length - 4} more</span>}
    </div>
  );
}

function feedbackKind(type: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (type === 'selected') return 'good';
  if (type.startsWith('missing')) return 'bad';
  if (type === 'rejected' || type === 'irrelevant' || type === 'stale') return 'bad';
  return 'warn';
}
