import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import { presentDraft } from '../presenters/draftPresenter.js';
import { DraftCard } from '../components/DraftCard.js';
import { DraftDetail } from '../components/DraftDetail.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';
import type {
  DraftRecommendation,
  KnowledgeItem,
  ReflectionDraft,
  ReflectionDraftStatus,
  WorkbenchSummary,
} from '../types.js';

type MemoryTab = 'drafts' | 'knowledge' | 'gaps' | 'proposals' | 'risky' | 'errors';

interface Props {
  summary: WorkbenchSummary | null;
  project: string;
  limit: number;
  refresh: () => void;
}

export function MemoryView({ summary, project, limit, refresh }: Props) {
  const [tab, setTab] = useState<MemoryTab>('drafts');
  return (
    <section data-testid="memory-view">
      <div class="panel">
        <h2>Memory review</h2>
        <p class="muted small">
          Approve, change, or reject what Tuberosa wants to remember. Each <GlossaryTerm termKey="reflection_draft">draft</GlossaryTerm>
          {' '}gets a recommendation built from the 11{' '}
          <GlossaryTerm termKey="learning_gate">learning gate</GlossaryTerm> checks.
        </p>
        <nav class="tabs" role="tablist">
          <TabButton current={tab} value="drafts" onSelect={setTab} label="Pending drafts" count={summary?.counts.pendingDrafts} />
          <TabButton current={tab} value="knowledge" onSelect={setTab} label="Knowledge" />
          <TabButton current={tab} value="gaps" onSelect={setTab} label="Gaps" count={summary?.counts.openGaps} />
          <TabButton current={tab} value="proposals" onSelect={setTab} label="Proposals" count={summary?.counts.openProposals} />
          <TabButton current={tab} value="risky" onSelect={setTab} label="Risky memories" count={summary?.counts.riskyAutoMemories} />
          <TabButton current={tab} value="errors" onSelect={setTab} label="Error logs" count={summary?.counts.openErrorLogs} />
        </nav>
      </div>

      {tab === 'drafts' && <DraftsTab project={project} limit={limit} onChange={refresh} />}
      {tab === 'knowledge' && <KnowledgeTab project={project} limit={limit} />}
      {tab === 'gaps' && <GapsTab summary={summary} />}
      {tab === 'proposals' && <ProposalsTab summary={summary} />}
      {tab === 'risky' && <RiskyTab summary={summary} />}
      {tab === 'errors' && <ErrorLogsTab summary={summary} />}
    </section>
  );
}

interface TabButtonProps {
  current: MemoryTab;
  value: MemoryTab;
  label: string;
  count?: number;
  onSelect: (v: MemoryTab) => void;
}

function TabButton({ current, value, label, count, onSelect }: TabButtonProps) {
  return (
    <button
      class={current === value ? 'active' : ''}
      role="tab"
      aria-selected={current === value}
      data-testid={`memory-tab-${value}`}
      onClick={() => onSelect(value)}
    >
      {label}{count !== undefined && count > 0 && <span class="pill muted" style={{ marginLeft: 6 }}>{count}</span>}
    </button>
  );
}

function DraftsTab({ project, limit, onChange }: { project: string; limit: number; onChange: () => void }) {
  const [drafts, setDrafts] = useState<ReflectionDraft[] | null>(null);
  const [recs, setRecs] = useState<Record<string, DraftRecommendation>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState<ReflectionDraftStatus>('pending');

  async function load() {
    setError(null);
    try {
      const items = await api<ReflectionDraft[]>(`/reflection-drafts`, { query: { project, limit, status } });
      setDrafts(items);
      // Fetch recommendations in parallel
      const entries = await Promise.allSettled(items.map((d) =>
        api<DraftRecommendation>(`/reflection-drafts/${d.id}/recommendation`).then((r) => [d.id, r] as const),
      ));
      const map: Record<string, DraftRecommendation> = {};
      for (const e of entries) {
        if (e.status === 'fulfilled') map[e.value[0]] = e.value[1];
      }
      setRecs(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { load(); }, [project, limit, status]);

  if (error) return <div class="panel"><div class="card bad">Error loading drafts: {error}</div></div>;
  if (drafts === null) return <div class="panel"><p class="muted">Loading drafts…</p></div>;

  return (
    <div class="panel">
      <div class="row between" style={{ marginBottom: 12 }}>
        <h3>Reflection drafts</h3>
        <div class="row">
          <label htmlFor="status-filter" class="small muted nowrap">Status</label>
          <select id="status-filter" value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value as ReflectionDraftStatus)}>
            <option value="pending">pending</option>
            <option value="needs_changes">needs_changes</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
          </select>
        </div>
      </div>
      {drafts.length === 0
        ? <EmptyState title={`No ${status} drafts`} hint="When agents finish complex tasks, drafts appear here for your review." />
        : drafts.map((d) => {
            const view = presentDraft(d, recs[d.id]);
            const isOpen = expanded === d.id;
            return (
              <div key={d.id}>
                <DraftCard draft={view} expanded={isOpen} onToggle={() => setExpanded(isOpen ? null : d.id)} />
                {isOpen && (
                  <DraftDetail
                    draftId={d.id}
                    rawDraft={d}
                    view={view}
                    onReviewed={() => { setExpanded(null); load(); onChange(); }}
                  />
                )}
              </div>
            );
          })
      }
    </div>
  );
}

function KnowledgeTab({ project, limit }: { project: string; limit: number }) {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('approved');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const result = await api<KnowledgeItem[]>('/knowledge', { query: { project, limit, status, q: query || undefined } });
      setItems(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { load(); }, [project, limit, status]);

  return (
    <div class="panel" data-testid="knowledge-tab">
      <div class="row between" style={{ marginBottom: 12 }}>
        <h3>Knowledge browser</h3>
        <div class="row">
          <input type="search" placeholder="Search title" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if ((e as KeyboardEvent).key === 'Enter') load(); }} />
          <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
            <option value="approved">approved</option>
            <option value="needs_review">needs_review</option>
            <option value="archived">archived</option>
            <option value="blocked">blocked</option>
          </select>
          <button onClick={load}>Search</button>
        </div>
      </div>
      {error && <div class="card bad">{error}</div>}
      {items === null && <p class="muted">Loading…</p>}
      {items && items.length === 0 && <EmptyState title="No knowledge items match." hint="Try a different status or query." />}
      {items?.map((item) => (
        <div class="card" key={item.id}>
          <div class="card-header">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div class="card-title">{item.title}</div>
              <div class="small muted">{item.summary}</div>
            </div>
            <div class="row" style={{ flexShrink: 0 }}>
              <Pill kind="accent">{item.itemType}</Pill>
              <Pill kind={trustKind(item.trustLevel)} title={`Trust ${item.trustLevel}/100`}>trust {item.trustLevel}</Pill>
            </div>
          </div>
          {item.labels.length > 0 && (
            <div class="row" style={{ marginTop: 6 }}>
              {item.labels.slice(0, 6).map((l, i) => <Pill key={i}>{l.type}: {l.value}</Pill>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GapsTab({ summary }: { summary: WorkbenchSummary | null }) {
  const gaps = summary?.openGaps ?? [];
  return (
    <div class="panel" data-testid="gaps-tab">
      <h3><GlossaryTerm termKey="knowledge_gap">Knowledge gaps</GlossaryTerm></h3>
      <p class="muted small">Inferred from missing-context decisions. Each one is a candidate to ingest new material for.</p>
      {gaps.length === 0
        ? <EmptyState title="No open gaps" hint="Tuberosa creates these when agents tell it the retrieved context was missing something." />
        : <ul class="bare">{gaps.map((g) => (
          <li class="card" key={g.id}>
            <div class="card-title">{g.topic ?? g.prompt ?? '(gap)'}</div>
            <div class="small muted">{describeMissingSignals(g.missingSignals)}</div>
          </li>
        ))}</ul>}
    </div>
  );
}

function describeMissingSignals(signals: unknown): string {
  if (!signals) return '';
  if (Array.isArray(signals)) return signals.join(' · ');
  if (typeof signals === 'object') {
    return Object.entries(signals as Record<string, string[]>)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k}: ${v.join(', ')}`)
      .join(' · ');
  }
  return String(signals);
}

function ProposalsTab({ summary }: { summary: WorkbenchSummary | null }) {
  const items = summary?.openProposals ?? [];
  return (
    <div class="panel" data-testid="proposals-tab">
      <h3><GlossaryTerm termKey="learning_proposal">Learning proposals</GlossaryTerm></h3>
      <p class="muted small">Cleanup suggestions inferred from feedback: rename labels, mark items as superseded, etc.</p>
      {items.length === 0
        ? <EmptyState title="No proposals" />
        : <ul class="bare">{items.map((p) => (
          <li class="card" key={p.id}>
            <div class="card-header">
              <div class="card-title">{p.title ?? p.reason ?? '(proposal)'}</div>
              <Pill kind="accent">{p.proposalType}</Pill>
            </div>
          </li>
        ))}</ul>}
    </div>
  );
}

function RiskyTab({ summary }: { summary: WorkbenchSummary | null }) {
  const risky = summary?.riskyAutoMemories ?? [];
  return (
    <div class="panel" data-testid="risky-tab">
      <h3>Risky auto-approved memories</h3>
      <p class="muted small">These were auto-approved but tripped at least one heuristic. Audit them before relying on the lessons.</p>
      {risky.length === 0
        ? <EmptyState title="No risky memories detected." />
        : <ul class="bare">{risky.map((r) => (
          <li class="card warn" key={r.id}>
            <div class="card-title">{r.title}</div>
            {r.reasons && r.reasons.length > 0 && (
              <ul class="bullets small muted">{r.reasons.map((rr, i) => <li key={i}>{rr}</li>)}</ul>
            )}
          </li>
        ))}</ul>}
    </div>
  );
}

function ErrorLogsTab({ summary }: { summary: WorkbenchSummary | null }) {
  const logs = summary?.openErrorLogs?.records ?? [];
  return (
    <div class="panel" data-testid="errors-tab">
      <h3><GlossaryTerm termKey="error_log">Error logs</GlossaryTerm></h3>
      <p class="muted small">Open incidents grouped by category and fingerprint.</p>
      {logs.length === 0
        ? <EmptyState title="No open error logs." />
        : <ul class="bare">{logs.map((log) => (
          <li class="card" key={log.id}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title">{log.title}</div>
                <div class="small muted">{log.category} · last seen {new Date(log.lastSeenAt).toLocaleString()} · {log.occurrenceCount} occurrences</div>
              </div>
              <Pill kind={severityKind(log.severity)}>{log.severity}</Pill>
            </div>
          </li>
        ))}</ul>}
    </div>
  );
}

function trustKind(t: number): 'good' | 'warn' | 'muted' {
  if (t >= 80) return 'good';
  if (t >= 50) return 'warn';
  return 'muted';
}

function severityKind(s: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (s === 'critical' || s === 'high') return 'bad';
  if (s === 'medium') return 'warn';
  return 'muted';
}
