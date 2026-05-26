import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { api, ApiError } from '../data/api.js';
import { currentProject, route, setRoute } from '../state/store.js';
import { SignalChips } from '../viz/SignalChips.js';
import { toSignalChips } from '../viz/signal-chips-vm.js';
import { PipelineFlow } from '../viz/PipelineFlow.js';
import { pipelineSteps } from '../viz/pipeline-flow-vm.js';
import { PackTimeline } from '../viz/PackTimeline.js';
import { toPackVM } from '../viz/pack-timeline-vm.js';

interface AgentSessionRow {
  id: string;
  project: string;
  prompt: string;
  status?: string;
  generatedAt?: string;
  createdAt?: string;
}

interface ReplayBundle {
  classifier: {
    symbols: string[];
    errors: string[];
    files: string[];
    businessAreas: string[];
    technologies: string[];
    taskType?: string;
  };
  timings: { totalMs: number; stageMs: Record<string, number> };
  pack: {
    essential: Array<{ id: string; title: string; tokens: number }>;
    supporting: Array<{ id: string; title: string; tokens: number }>;
    optional: Array<{ id: string; title: string; tokens: number }>;
  };
  contextFit?: { status?: string; fitStatus?: string };
}

export default function Ch09_YourSessions() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 9) : undefined), []);

  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionRow[] | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [replay, setReplay] = useState<ReplayBundle | null>(null);
  const [replayError, setReplayError] = useState<'missing' | 'other' | null>(null);

  const selectedId = route.value.sessionId;

  useEffect(() => {
    if (!open || sessions !== null) return;
    setLoadingSessions(true);
    api<{ items: AgentSessionRow[] }>('/agent-sessions', {
      query: { project: currentProject.value, limit: 20 },
    })
      .then((r) => setSessions(r.items ?? []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, [open]);

  useEffect(() => {
    if (!selectedId) {
      setReplay(null);
      setReplayError(null);
      return;
    }
    setReplay(null);
    setReplayError(null);
    api<ReplayBundle>(`/operations/workbench/session/${encodeURIComponent(selectedId)}/replay`)
      .then(setReplay)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) setReplayError('missing');
        else setReplayError('other');
      });
  }, [selectedId]);

  return (
    <section id="ch9" class="chapter" data-numeral="09" ref={ref}>
      <span class="overline">Your sessions</span>
      <h2 style="margin-top:var(--space-4)">Inspect your own sessions</h2>
      <p class="lead">
        Real Tuberosa sessions in this checkout. Replay needs{' '}
        <span class="code">TUBEROSA_PERSIST_REPLAY=true</span>.
      </p>
      <details
        open={open}
        onToggle={(e: Event) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        style="margin-top:16px"
      >
        <summary style="cursor:pointer">
          Show recent sessions for <span class="code">{currentProject.value}</span>
        </summary>
        {loadingSessions && <div style="margin-top:8px">Loading sessions…</div>}
        {sessions && sessions.length === 0 && (
          <div style="margin-top:8px;color:var(--fg-muted)">No sessions found.</div>
        )}
        {sessions && sessions.length > 0 && (
          <ul style="margin-top:8px;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  class="card"
                  onClick={() => setRoute({ ...route.value, sessionId: s.id })}
                  style={`width:100%;text-align:left;cursor:pointer;border-color:${selectedId === s.id ? 'var(--accent)' : 'var(--line)'}`}
                >
                  <div style="display:flex;justify-content:space-between;gap:8px">
                    <strong style="overflow:hidden;text-overflow:ellipsis">{s.prompt}</strong>
                    <span class="pill">{s.status ?? '—'}</span>
                  </div>
                  <div style="color:var(--fg-muted);font-size:12px;margin-top:4px">
                    <span class="code">{s.id}</span> · {s.generatedAt ?? s.createdAt ?? ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selectedId && replayError === 'missing' && (
          <div
            class="card"
            data-tone="warm"
            style="margin-top:12px;border-color:var(--accent-warm)"
          >
            No replay recorded for this session. Enable persistence with{' '}
            <span class="code">TUBEROSA_PERSIST_REPLAY=true</span> and finish a new session.
          </div>
        )}
        {selectedId && replayError === 'other' && (
          <div class="card" style="margin-top:12px;border-color:var(--bad)">
            Could not load replay.
          </div>
        )}
        {replay && (
          <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div>
              <h3>Signals</h3>
              <SignalChips chips={toSignalChips(replay.classifier)} />
              <h3 style="margin-top:16px">Pipeline</h3>
              <PipelineFlow steps={pipelineSteps(replay.timings.stageMs)} />
            </div>
            <div>
              <h3>Pack</h3>
              <PackTimeline vm={toPackVM(replay.pack)} />
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
