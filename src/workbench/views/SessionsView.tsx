import type { WorkbenchSummary } from '../types.js';
import { navigate } from '../state/store.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';

export function SessionsView({ summary }: { summary: WorkbenchSummary | null }) {
  const sessions = summary?.recentSessions ?? [];
  return (
    <section class="sessions-view" data-testid="sessions-view">
      <h1>Sessions</h1>
      <p class="muted">Context mapping runs, newest first.</p>
      {sessions.length === 0
        ? <EmptyState title="No sessions yet" hint="Map your first task from Start." />
        : sessions.map((session) => (
          <button class="session-row" key={session.id} onClick={() => navigate({ view: 'session', sessionId: session.id })}>
            <strong>{session.prompt}</strong>
            <Pill kind={session.status === 'active' ? 'warn' : 'good'}>{session.outcome ?? session.status}</Pill>
          </button>
        ))}
    </section>
  );
}
