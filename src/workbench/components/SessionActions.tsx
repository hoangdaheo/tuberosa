import { useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { ContextDecisionResult, FinishSessionResult } from '../types.js';
import { Pill } from './Pill.js';

interface Props {
  sessionId: string;
  onChanged: () => void;
}

export function SessionActions({ sessionId, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState('selected');
  const [reason, setReason] = useState('');
  const [decisionResult, setDecisionResult] = useState<ContextDecisionResult | null>(null);
  const [outcome, setOutcome] = useState('completed');
  const [summary, setSummary] = useState('');
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null);

  async function recordDecision() {
    setBusy(true);
    try {
      const result = await api<ContextDecisionResult>(`/agent-sessions/${sessionId}/context-decision`, {
        method: 'POST',
        body: { feedbackType: decision, reason: reason || undefined },
      });
      setDecisionResult(result);
      pushToast('Context decision recorded.', 'good');
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function finishSession() {
    setBusy(true);
    try {
      const result = await api<FinishSessionResult>(`/agent-sessions/${sessionId}/finish`, {
        method: 'POST',
        body: { outcome, summary: summary || undefined },
      });
      setFinishResult(result);
      pushToast('Session finished.', 'good');
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="session-actions">
      <div class="panel" data-testid="decision-panel">
        <h2>Record decision</h2>
        <p class="muted small">Tell Tuberosa whether this context helped so future retrieval can improve.</p>
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="decision-type">Decision</label>
            <select id="decision-type" value={decision} onChange={(e) => setDecision((e.target as HTMLSelectElement).value)}>
              <option value="selected">selected</option>
              <option value="selected_but_noisy">selected_but_noisy</option>
              <option value="rejected">rejected</option>
              <option value="stale">stale</option>
              <option value="irrelevant">irrelevant</option>
              <option value="missing_context">missing_context</option>
            </select>
          </div>
          <div class="form-row">
            <label htmlFor="decision-reason">Reason</label>
            <input id="decision-reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <button class="primary" disabled={busy} onClick={recordDecision} data-testid="record-decision">{busy ? 'Working...' : 'Record decision'}</button>
        {decisionResult && <p class="small good-line" data-testid="decision-recorded">Recorded <Pill kind="good">{decisionResult.decision.decision}</Pill></p>}
      </div>

      <div class="panel" data-testid="finish-panel">
        <h2>Finish session</h2>
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="finish-outcome">Outcome</label>
            <select id="finish-outcome" value={outcome} onChange={(e) => setOutcome((e.target as HTMLSelectElement).value)}>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="blocked">blocked</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
          <div class="form-row">
            <label htmlFor="finish-summary">Summary</label>
            <textarea id="finish-summary" value={summary} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
        <button class="primary" disabled={busy} onClick={finishSession} data-testid="finish-session">{busy ? 'Working...' : 'Finish session'}</button>
        {finishResult && (
          <div class="finish-result" data-testid="finish-result">
            <Pill kind="good">{finishResult.session.status}</Pill>
            <Pill kind={finishResult.compliance.status === 'compliant' ? 'good' : 'warn'}>compliance: {finishResult.compliance.status}</Pill>
            {finishResult.learningDecision && <Pill kind="accent">learning: {finishResult.learningDecision.status}</Pill>}
            <p class="small muted">{finishResult.compliance.instruction}</p>
          </div>
        )}
      </div>
    </section>
  );
}
