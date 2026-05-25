import { useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';
import { Pill } from '../components/Pill.js';
import { EmptyState } from '../components/EmptyState.js';
import { presentSessionStart, type SessionViewModel, type EvidenceRow } from '../presenters/sessionPresenter.js';
import { StartupBriefPanel } from './StartupBriefPanel.js';
import { ResearchTraceFromMetadata } from './ResearchTracePanel.js';
import type { AgentSessionStartResult, ContextDecisionResult, FinishSessionResult } from '../types.js';

interface FormState {
  prompt: string;
  project: string;
  cwd: string;
  taskType: string;
  contextMode: 'compact' | 'layered';
}

const DEFAULT_FORM: FormState = {
  prompt: '',
  project: '',
  cwd: '',
  taskType: '',
  contextMode: 'compact',
};

interface Props { defaultProject: string }

export function SessionView({ defaultProject }: Props) {
  const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM, project: defaultProject });
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<SessionViewModel | null>(null);
  const [decisionLog, setDecisionLog] = useState<Array<{ decision: string; reason?: string }>>([]);
  const [decisionForm, setDecisionForm] = useState<{ feedback: string; reason: string }>({ feedback: 'selected', reason: '' });
  const [finishForm, setFinishForm] = useState<{ outcome: string; summary: string }>({ outcome: 'completed', summary: '' });
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function start(e: Event) {
    e.preventDefault();
    if (!form.prompt.trim()) {
      pushToast('Enter a prompt to start a session.', 'bad');
      return;
    }
    setBusy(true);
    setFinishResult(null);
    setDecisionLog([]);
    try {
      const result = await api<AgentSessionStartResult>('/agent-sessions', {
        method: 'POST',
        body: {
          prompt: form.prompt,
          project: form.project || undefined,
          cwd: form.cwd || undefined,
          taskType: form.taskType || undefined,
          contextMode: form.contextMode,
        },
      });
      setSession(presentSessionStart(result));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function recordDecision() {
    if (!session) return;
    setBusy(true);
    try {
      const result = await api<ContextDecisionResult>(`/agent-sessions/${session.sessionId}/context-decision`, {
        method: 'POST',
        body: {
          feedbackType: decisionForm.feedback,
          reason: decisionForm.reason || undefined,
        },
      });
      setDecisionLog((prev) => [...prev, { decision: result.decision.decision, reason: result.decision.reason }]);
      setDecisionForm({ feedback: 'selected', reason: '' });
      pushToast('Decision recorded.', 'good');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!session) return;
    setBusy(true);
    try {
      const result = await api<FinishSessionResult>(`/agent-sessions/${session.sessionId}/finish`, {
        method: 'POST',
        body: {
          outcome: finishForm.outcome,
          summary: finishForm.summary || undefined,
        },
      });
      setFinishResult(result);
      pushToast('Session finished.', 'good');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div class="panel">
        <h2>Start an <GlossaryTerm termKey="agent_session">agent session</GlossaryTerm></h2>
        <p class="muted small">
          Submit a prompt to retrieve a <GlossaryTerm termKey="context_pack">context pack</GlossaryTerm> and audit
          how Tuberosa ranks knowledge for the task.
        </p>
        <form onSubmit={start} class="stack" data-testid="session-form">
          <div class="form-row">
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              value={form.prompt}
              data-testid="session-prompt"
              onInput={(e) => update('prompt', (e.target as HTMLTextAreaElement).value)}
              placeholder="e.g. Fix the TS-999 error in src/auth.ts"
              required
            />
          </div>
          <div class="form-grid">
            <div class="form-row">
              <label htmlFor="project">Project</label>
              <input id="project" type="text" value={form.project} onInput={(e) => update('project', (e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-row">
              <label htmlFor="cwd">Working directory</label>
              <input id="cwd" type="text" placeholder="/path/to/repo" value={form.cwd} onInput={(e) => update('cwd', (e.target as HTMLInputElement).value)} />
            </div>
            <div class="form-row">
              <label htmlFor="taskType">Task type</label>
              <select id="taskType" value={form.taskType} onChange={(e) => update('taskType', (e.target as HTMLSelectElement).value)}>
                <option value="">(auto)</option>
                <option value="implementation">implementation</option>
                <option value="debugging">debugging</option>
                <option value="refactor">refactor</option>
                <option value="testing">testing</option>
                <option value="design">design</option>
              </select>
            </div>
            <div class="form-row">
              <label htmlFor="contextMode">Context mode</label>
              <select id="contextMode" value={form.contextMode} onChange={(e) => update('contextMode', (e.target as HTMLSelectElement).value as FormState['contextMode'])}>
                <option value="compact">compact (summaries only)</option>
                <option value="layered">layered (with deep context)</option>
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary" disabled={busy}>{busy ? 'Working…' : 'Start session'}</button>
          </div>
        </form>
      </div>

      {session && <SessionResult session={session} />}

      {session && (
        <div class="panel" data-testid="decision-panel">
          <h2>Record a <GlossaryTerm termKey="context_decision">context decision</GlossaryTerm></h2>
          <div class="form-grid">
            <div class="form-row">
              <label htmlFor="feedback">Decision</label>
              <select id="feedback" value={decisionForm.feedback} onChange={(e) => setDecisionForm({ ...decisionForm, feedback: (e.target as HTMLSelectElement).value })}>
                <option value="selected">selected</option>
                <option value="selected_but_noisy">selected_but_noisy</option>
                <option value="rejected">rejected</option>
                <option value="stale">stale</option>
                <option value="irrelevant">irrelevant</option>
                <option value="missing_context">missing_context</option>
              </select>
            </div>
            <div class="form-row">
              <label htmlFor="reason">Reason (optional)</label>
              <input id="reason" type="text" value={decisionForm.reason} onInput={(e) => setDecisionForm({ ...decisionForm, reason: (e.target as HTMLInputElement).value })} />
            </div>
          </div>
          <div class="form-actions">
            <button class="primary" onClick={recordDecision} disabled={busy} data-testid="record-decision">Record decision</button>
          </div>
          {decisionLog.length > 0 && (
            <ul class="bullets small" data-testid="decision-log" style={{ marginTop: 12 }}>
              {decisionLog.map((d, i) => <li key={i}><Pill>{d.decision}</Pill> {d.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      {session && (
        <div class="panel" data-testid="finish-panel">
          <h2>Finish session</h2>
          <p class="muted small">
            Closing the session lets Tuberosa decide via the <GlossaryTerm termKey="learning_gate">learning gate</GlossaryTerm>
            whether to auto-approve a <GlossaryTerm termKey="reflection_draft">reflection draft</GlossaryTerm> or
            queue it for review.
          </p>
          <div class="form-grid">
            <div class="form-row">
              <label htmlFor="outcome">Outcome</label>
              <select id="outcome" value={finishForm.outcome} onChange={(e) => setFinishForm({ ...finishForm, outcome: (e.target as HTMLSelectElement).value })}>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
                <option value="blocked">blocked</option>
                <option value="cancelled">cancelled</option>
              </select>
            </div>
            <div class="form-row">
              <label htmlFor="finish-summary">Summary</label>
              <textarea id="finish-summary" value={finishForm.summary} onInput={(e) => setFinishForm({ ...finishForm, summary: (e.target as HTMLTextAreaElement).value })} />
            </div>
          </div>
          <div class="form-actions">
            <button class="primary" onClick={finish} disabled={busy} data-testid="finish-session">Finish</button>
          </div>
          {finishResult && (
            <div class="card" data-testid="finish-result" style={{ marginTop: 12 }}>
              <div class="row">
                <Pill kind="accent">{finishResult.session.status}</Pill>
                <Pill kind={finishResult.compliance.status === 'compliant' ? 'good' : 'warn'}>
                  compliance: {finishResult.compliance.status}
                </Pill>
                {finishResult.learningDecision && (
                  <Pill kind={finishResult.learningDecision.status === 'auto_approved' ? 'good' : 'muted'}>
                    learning: {finishResult.learningDecision.status}
                  </Pill>
                )}
              </div>
              <p class="small muted" style={{ marginTop: 8 }}>{finishResult.compliance.instruction}</p>
              {finishResult.learningDecision?.reasons.length ? (
                <ul class="bullets small muted">
                  {finishResult.learningDecision.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              ) : null}
              <ResearchTraceFromMetadata metadata={finishResult.session.metadata} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SessionResult({ session }: { session: SessionViewModel }) {
  return (
    <div class="panel" data-testid="session-result" id="sessionResult">
      <header class="row between">
        <h2>Session: <code>{session.sessionId}</code></h2>
        <Pill kind={fitKind(session.fitStatus)}>{session.fitStatus}</Pill>
      </header>
      <p class="muted small">{session.fitHeadline}</p>
      <p class="small">
        <strong>Policy:</strong> <Pill kind="accent">{session.policyAction}</Pill> {session.policyInstruction}
      </p>

      {session.startupBrief && <StartupBriefPanel brief={session.startupBrief} />}

      {session.goal && <>
        <h4>Task brief</h4>
        <p>{session.goal}</p>
      </>}

      {session.actionItems.length > 0 && <>
        <h4>Action items</h4>
        <ol class="bullets small" style={{ paddingLeft: '1.4em' }}>
          {session.actionItems.map((a) => (
            <li key={`${a.priority}-${a.label}`}>
              <strong>{a.label}.</strong>{' '}
              {a.reason && <span class="muted">{a.reason}</span>}
              {a.command && <> <code>{a.command}</code></>}
              {a.targetPath && <> <code>{a.targetPath}</code></>}
            </li>
          ))}
        </ol>
      </>}

      {session.verificationCommands.length > 0 && <>
        <h4>Verification commands</h4>
        <ul class="bullets small">
          {session.verificationCommands.map((cmd, i) => <li key={i}><code>{cmd}</code></li>)}
        </ul>
      </>}

      {session.missingSignals.length > 0 && <>
        <h4>Missing signals</h4>
        <ul class="bullets small muted">
          {session.missingSignals.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      </>}

      <EvidenceBlock title="Direct evidence" rows={session.essential} testid="essential-evidence" />
      <EvidenceBlock title="Supporting" rows={session.supporting} testid="supporting-evidence" />
      <EvidenceBlock title="Adjacent" rows={session.optional} testid="optional-evidence" />
    </div>
  );
}

function EvidenceBlock({ title, rows, testid }: { title: string; rows: EvidenceRow[]; testid: string }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul class="bare" data-testid={testid}>
        {rows.map((row) => (
          <li class="card muted" key={row.knowledgeId} style={{ marginBottom: 8 }}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title truncate">{row.title}</div>
                <div class="small muted">{row.summary}</div>
              </div>
              <div class="row" style={{ flexShrink: 0 }}>
                <Pill>{row.itemType}</Pill>
                <Pill kind="accent">{row.evidenceCategoryLabel}</Pill>
                <Pill kind={strengthKind(row.evidenceStrengthLabel)}>{row.evidenceStrengthLabel}</Pill>
              </div>
            </div>
            {row.usefulnessReason && <p class="small">{row.usefulnessReason}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}

function fitKind(status: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (status === 'ready') return 'good';
  if (status === 'needs_confirmation') return 'warn';
  if (status === 'insufficient') return 'bad';
  return 'muted';
}

function strengthKind(strength: string): 'good' | 'warn' | 'muted' {
  if (strength === 'strong') return 'good';
  if (strength === 'moderate') return 'warn';
  return 'muted';
}

export function _empty() { return <EmptyState title="" />; }
