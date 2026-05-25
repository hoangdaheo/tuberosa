import { useEffect, useState } from 'preact/hooks';
import type { DraftViewModel } from '../presenters/draftPresenter.js';
import type { DraftRecommendation, ReflectionDraft } from '../types.js';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import { GlossaryTerm } from './GlossaryTerm.js';
import { Markdown } from './Markdown.js';
import { Pill } from './Pill.js';
import { RecommendationPanel } from './RecommendationPanel.js';
import { ResearchTracePanel } from '../views/ResearchTracePanel.js';
import { extractResearchTrace } from '../presenters/researchTracePresenter.js';

interface Props {
  draftId: string;
  rawDraft: ReflectionDraft;
  view: DraftViewModel;
  onReviewed: () => void;
}

export function DraftDetail({ draftId, rawDraft, view, onReviewed }: Props) {
  const [recommendation, setRecommendation] = useState<DraftRecommendation | null>(null);
  const [recError, setRecError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRecommendation(null);
    setRecError(null);
    api<DraftRecommendation>(`/reflection-drafts/${draftId}/recommendation`)
      .then((res) => { if (!cancelled) setRecommendation(res); })
      .catch((err) => { if (!cancelled) setRecError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [draftId]);

  async function review(decision: 'approve' | 'reject' | 'needs_changes') {
    setBusy(true);
    try {
      await api(`/reflection-drafts/${draftId}/review`, { method: 'POST', body: { decision } });
      pushToast(`Draft marked ${decision.replace('_', ' ')}.`, 'good');
      onReviewed();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="panel" data-testid="draft-detail">
      <header class="row between" style={{ marginBottom: 12 }}>
        <h2>{view.headline}</h2>
        <Pill kind="muted">{view.itemTypeLabel}</Pill>
      </header>

      <p class="muted">{view.whereItCameFrom.label} <span class="small">· {view.whyItExists}</span></p>

      {recError && <div class="card bad">Could not load recommendation: {recError}</div>}
      {!recommendation && !recError && <div class="card muted small">Loading recommendation…</div>}
      {recommendation && (
        <RecommendationPanel
          recommendation={recommendation}
          busy={busy}
          onApprove={() => review('approve')}
          onNeedsChanges={() => review('needs_changes')}
          onReject={() => review('reject')}
        />
      )}

      <h3>What the lesson claims</h3>
      <Markdown text={rawDraft.content} />

      <div class="divider" />

      <div class="form-grid">
        <div>
          <h4>Suggested <GlossaryTerm termKey="label">labels</GlossaryTerm></h4>
          {rawDraft.suggestedLabels.length === 0
            ? <p class="muted small">No labels suggested. The draft may not surface for relevant future tasks.</p>
            : <div class="row">{rawDraft.suggestedLabels.map((l, i) =>
              <Pill key={i} kind={concreteLabel(l.type) ? 'accent' : 'muted'}>
                {l.type}: {l.value}
              </Pill>)}
            </div>}
        </div>
        <div>
          <h4><GlossaryTerm termKey="reference">References</GlossaryTerm></h4>
          {rawDraft.references.length === 0
            ? <p class="muted small">No references attached.</p>
            : <ul class="bullets small">{rawDraft.references.map((r, i) => (
              <li key={i}><Pill kind={r.type === 'conversation' ? 'muted' : 'accent'}>{r.type}</Pill>{' '}<code>{r.uri}</code></li>
            ))}</ul>}
        </div>
      </div>

      {(() => {
        const trace = extractResearchTrace(rawDraft.metadata);
        return trace ? <ResearchTracePanel trace={trace} /> : null;
      })()}

      {view.duplicates.length > 0 && (
        <>
          <div class="divider" />
          <h4 style={{ color: 'var(--bad)' }}><GlossaryTerm termKey="duplicate_candidate">Duplicate candidates</GlossaryTerm></h4>
          <ul class="bullets small">
            {view.duplicates.map((d, i) => (
              <li key={i}><strong>{Math.round(d.score * 100)}%</strong> — {d.title}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function concreteLabel(type: string): boolean {
  return type === 'task_type' || type === 'file' || type === 'symbol' || type === 'error';
}
