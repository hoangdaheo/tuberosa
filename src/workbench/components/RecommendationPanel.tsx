import { useState } from 'preact/hooks';
import type { DraftRecommendation } from '../types.js';
import { Pill } from './Pill.js';

interface Props {
  recommendation: DraftRecommendation;
  onApprove: (force: boolean) => void;
  onNeedsChanges: () => void;
  onReject: () => void;
  busy?: boolean;
}

export function RecommendationPanel({ recommendation, onApprove, onNeedsChanges, onReject, busy }: Props) {
  const [confirmingForce, setConfirmingForce] = useState(false);
  const verdict = recommendation.verdict;
  const icon = verdict === 'approve' ? '✓' : verdict === 'reject' ? '✕' : '⚠';
  const verdictTitle =
    verdict === 'approve' ? 'Recommended: Approve' :
    verdict === 'reject' ? 'Recommended: Reject' :
    'Recommended: Needs changes';

  return (
    <section class="recommendation" data-testid="recommendation-panel">
      <header class={`verdict-head ${verdict}`}>
        <div class="verdict-icon" aria-hidden="true">{icon}</div>
        <div class="verdict-text">
          <div class="title" data-testid="recommendation-verdict">{verdictTitle}</div>
          <div class="rationale">{recommendation.oneLineRationale}</div>
        </div>
        <Pill kind={confidenceKind(recommendation.confidence)} title={`Confidence: ${recommendation.confidence}`}>
          {recommendation.confidence} confidence
        </Pill>
      </header>

      {recommendation.pros.length > 0 && (
        <div class="verdict-section pros" data-testid="recommendation-pros">
          <h4>Why approve</h4>
          <ul class="bullets">
            {recommendation.pros.map((p) => (
              <li key={p.key}><strong>{p.label}.</strong> {p.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {recommendation.cons.length > 0 && (
        <div class="verdict-section cons" data-testid="recommendation-cons">
          <h4>Things to double-check</h4>
          <ul class="bullets">
            {recommendation.cons.map((c) => (
              <li key={c.key}><strong>{c.label}.</strong> {c.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {recommendation.blockers.length > 0 && (
        <div class="verdict-section blockers" data-testid="recommendation-blockers">
          <h4>Reasons not to approve</h4>
          <ul class="bullets">
            {recommendation.blockers.map((b) => (
              <li key={b.key}><strong>{b.label}.</strong> {b.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {recommendation.unknowns.length > 0 && (
        <div class="verdict-section" data-testid="recommendation-unknowns">
          <h4>Not yet evaluable</h4>
          <ul class="bullets small muted">
            {recommendation.unknowns.map((u) => (
              <li key={u.key}>{u.label} — {u.detail}</li>
            ))}
          </ul>
        </div>
      )}

      <div class="verdict-actions">
        {recommendation.blockers.length > 0 && !confirmingForce ? (
          <>
            <button
              class="primary"
              disabled={busy}
              onClick={() => setConfirmingForce(true)}
              data-testid="approve-button"
            >Approve anyway…</button>
            <button class="warn" disabled={busy} onClick={onNeedsChanges} data-testid="needs-changes-button">Needs changes</button>
            <button class="danger" disabled={busy} onClick={onReject} data-testid="reject-button">Reject</button>
          </>
        ) : confirmingForce ? (
          <>
            <span class="small">
              This draft has {recommendation.blockers.length} blocker{recommendation.blockers.length === 1 ? '' : 's'}. Approve anyway?
            </span>
            <button class="danger" disabled={busy} onClick={() => onApprove(true)} data-testid="approve-confirm">Yes, approve</button>
            <button class="ghost" disabled={busy} onClick={() => setConfirmingForce(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button
              class="primary"
              disabled={busy}
              onClick={() => onApprove(false)}
              data-testid="approve-button"
            >Approve</button>
            <button class="warn" disabled={busy} onClick={onNeedsChanges} data-testid="needs-changes-button">Needs changes</button>
            <button class="danger" disabled={busy} onClick={onReject} data-testid="reject-button">Reject</button>
          </>
        )}
      </div>
    </section>
  );
}

function confidenceKind(c: DraftRecommendation['confidence']): 'good' | 'warn' | 'muted' {
  if (c === 'high') return 'good';
  if (c === 'medium') return 'warn';
  return 'muted';
}
