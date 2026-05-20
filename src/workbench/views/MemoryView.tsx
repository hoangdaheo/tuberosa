import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Archive, Check, CircleAlert, X } from 'lucide-preact';
import { api } from '../state/api.js';
import { navigate, pushToast } from '../state/store.js';
import { presentDraft } from '../presenters/draftPresenter.js';
import { DraftCard } from '../components/DraftCard.js';
import { DraftDetail } from '../components/DraftDetail.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';
import type { MemoryTabName } from '../state/store.js';
import type {
  DraftRecommendation,
  KnowledgeItem,
  ReflectionDraft,
  ReflectionDraftStatus,
  WorkbenchSummary,
} from '../types.js';

interface Props {
  summary: WorkbenchSummary | null;
  project: string;
  limit: number;
  refresh: () => void;
  activeTab: MemoryTabName;
}

export function MemoryView({ summary, project, limit, refresh, activeTab }: Props) {
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
          <TabButton current={activeTab} value="drafts" label="Pending drafts" count={summary?.counts.pendingDrafts} />
          <TabButton current={activeTab} value="knowledge" label="Knowledge" />
          <TabButton current={activeTab} value="gaps" label="Gaps" count={summary?.counts.openGaps} />
          <TabButton current={activeTab} value="proposals" label="Proposals" count={summary?.counts.openProposals} />
          <TabButton current={activeTab} value="conflicts" label="Conflicts" count={summary?.counts.openConflicts} />
          <TabButton current={activeTab} value="risky" label="Risky memories" count={summary?.counts.riskyAutoMemories} />
          <TabButton current={activeTab} value="errors" label="Error logs" count={summary?.counts.openErrorLogs} />
        </nav>
      </div>

      {activeTab === 'drafts' && <DraftsTab project={project} limit={limit} onChange={refresh} />}
      {activeTab === 'knowledge' && <KnowledgeTab project={project} limit={limit} />}
      {activeTab === 'gaps' && <GapsTab summary={summary} refresh={refresh} />}
      {activeTab === 'proposals' && <ProposalsTab summary={summary} refresh={refresh} />}
      {activeTab === 'conflicts' && <ConflictsTab summary={summary} refresh={refresh} />}
      {activeTab === 'risky' && <RiskyTab summary={summary} refresh={refresh} />}
      {activeTab === 'errors' && <ErrorLogsTab summary={summary} refresh={refresh} />}
    </section>
  );
}

interface TabButtonProps {
  current: MemoryTabName;
  value: MemoryTabName;
  label: string;
  count?: number;
}

function TabButton({ current, value, label, count }: TabButtonProps) {
  return (
    <button
      class={current === value ? 'active' : ''}
      role="tab"
      aria-selected={current === value}
      data-testid={`memory-tab-${value}`}
      onClick={() => navigate({ view: 'memory', memoryTab: value })}
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

function GapsTab({ summary, refresh }: { summary: WorkbenchSummary | null; refresh: () => void }) {
  const gaps = summary?.openGaps ?? [];
  return (
    <div class="panel" data-testid="gaps-tab">
      <h3><GlossaryTerm termKey="knowledge_gap">Knowledge gaps</GlossaryTerm></h3>
      <p class="muted small">Inferred from missing-context decisions. Each one is a candidate to ingest new material for.</p>
      {gaps.length === 0
        ? <EmptyState title="No open gaps" hint="Tuberosa creates these when agents tell it the retrieved context was missing something." />
        : <ul class="bare">{gaps.map((g) => (
          <li class="card" key={g.id}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title">{g.reason ?? g.prompt}</div>
                <div class="small muted">created {new Date(g.createdAt).toLocaleString()} · {g.missingSignalCount} missing signal{g.missingSignalCount === 1 ? '' : 's'}</div>
              </div>
              <Pill kind="warn">{g.status}</Pill>
            </div>
            {g.prompt && <p class="small">{g.prompt}</p>}
            {g.missingSignals.length > 0 && <div class="small muted wrap-anywhere">{describeMissingSignals(g.missingSignals)}</div>}
            <QueueActions>
              <QueueActionButton path={`/operations/knowledge-gaps/${g.id}`} body={{ status: 'approved' }} queue="Knowledge gaps" label="Approve" kind="primary" icon="check" onDone={refresh} />
              <QueueActionButton path={`/operations/knowledge-gaps/${g.id}`} body={{ status: 'needs_changes' }} queue="Knowledge gaps" label="Needs changes" kind="warn" icon="alert" onDone={refresh} />
              <QueueActionButton path={`/operations/knowledge-gaps/${g.id}`} body={{ status: 'dismissed' }} queue="Knowledge gaps" label="Dismiss" kind="danger" icon="x" onDone={refresh} />
            </QueueActions>
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

function ProposalsTab({ summary, refresh }: { summary: WorkbenchSummary | null; refresh: () => void }) {
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
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title">{p.reason}</div>
                <div class="small muted">
                  {p.affectedKnowledgeId && <>affected <code>{p.affectedKnowledgeId}</code> · </>}
                  {p.evidenceCount} evidence item{p.evidenceCount === 1 ? '' : 's'}
                </div>
              </div>
              <div class="row" style={{ flexShrink: 0 }}>
                <Pill kind="accent">{p.proposalType}</Pill>
                <Pill kind="warn">{p.status}</Pill>
              </div>
            </div>
            {p.evidence.length > 0 && (
              <ul class="bullets small muted">
                {p.evidence.map((entry, i) => <li key={i}>{entry}</li>)}
              </ul>
            )}
            <QueueActions>
              <QueueActionButton path={`/operations/learning-proposals/${p.id}`} body={{ status: 'approved' }} queue="Learning proposals" label="Approve" kind="primary" icon="check" onDone={refresh} />
              <QueueActionButton path={`/operations/learning-proposals/${p.id}`} body={{ status: 'needs_changes' }} queue="Learning proposals" label="Needs changes" kind="warn" icon="alert" onDone={refresh} />
              <QueueActionButton path={`/operations/learning-proposals/${p.id}`} body={{ status: 'dismissed' }} queue="Learning proposals" label="Dismiss" kind="danger" icon="x" onDone={refresh} />
            </QueueActions>
          </li>
        ))}</ul>}
    </div>
  );
}

function ConflictsTab({ summary, refresh }: { summary: WorkbenchSummary | null; refresh: () => void }) {
  const conflicts = summary?.openConflicts ?? [];
  return (
    <div class="panel" data-testid="conflicts-tab">
      <h3>Knowledge conflicts</h3>
      <p class="muted small">Open contradictions or freshness conflicts that can make future context packs unreliable.</p>
      {conflicts.length === 0
        ? <EmptyState title="No open conflicts" hint="Conflicts detected by operations review will appear here." />
        : <ul class="bare">{conflicts.map((conflict) => (
          <li class="card" key={conflict.id}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title">{conflict.reason}</div>
                <div class="small muted">
                  <code>{conflict.leftKnowledgeId}</code> vs <code>{conflict.rightKnowledgeId}</code>
                </div>
              </div>
              <div class="row" style={{ flexShrink: 0 }}>
                <Pill kind="bad">{conflict.conflictType}</Pill>
                <Pill kind="warn">{conflict.status}</Pill>
              </div>
            </div>
            {conflict.sharedEvidence.length > 0 && (
              <div class="small muted wrap-anywhere">
                <strong>Shared evidence:</strong> {conflict.sharedEvidence.join(' · ')}
                {conflict.sharedEvidenceCount > conflict.sharedEvidence.length && ` · +${conflict.sharedEvidenceCount - conflict.sharedEvidence.length} more`}
              </div>
            )}
            <QueueActions>
              <QueueActionButton path={`/operations/conflicts/${conflict.id}`} body={{ status: 'resolved' }} queue="Knowledge conflicts" label="Resolve" kind="primary" icon="check" onDone={refresh} />
              <QueueActionButton path={`/operations/conflicts/${conflict.id}`} body={{ status: 'dismissed' }} queue="Knowledge conflicts" label="Dismiss" kind="danger" icon="x" onDone={refresh} />
            </QueueActions>
          </li>
        ))}</ul>}
    </div>
  );
}

function RiskyTab({ summary, refresh }: { summary: WorkbenchSummary | null; refresh: () => void }) {
  const risky = summary?.riskyAutoMemories ?? [];
  return (
    <div class="panel" data-testid="risky-tab">
      <h3>Risky auto-approved memories</h3>
      <p class="muted small">These were auto-approved but tripped at least one heuristic. Audit them before relying on the lessons.</p>
      {risky.length === 0
        ? <EmptyState title="No risky memories detected." />
        : <ul class="bare">{risky.map((r) => (
          <li class="card warn" key={r.id}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div class="card-title">{r.title}</div>
                <div class="small muted">{r.summary}</div>
              </div>
              <div class="row" style={{ flexShrink: 0 }}>
                <Pill kind={trustKind(r.trustLevel)} title={`Trust ${r.trustLevel}/100`}>trust {r.trustLevel}</Pill>
                <Pill kind="muted">{r.status ?? 'approved'}</Pill>
              </div>
            </div>
            <div class="row small muted">
              <span>{r.itemType}</span>
              <span>{r.labelCount} label{r.labelCount === 1 ? '' : 's'}</span>
              <span>{r.referenceCount} reference{r.referenceCount === 1 ? '' : 's'}</span>
            </div>
            <QueueActions>
              <QueueActionButton path={`/knowledge/${r.id}`} body={{ status: 'needs_review' }} queue="Risky memories" label="Mark needs review" kind="warn" icon="alert" onDone={refresh} />
              <QueueActionButton path={`/knowledge/${r.id}`} body={{ status: 'archived' }} queue="Risky memories" label="Archive" kind="danger" icon="archive" onDone={refresh} />
            </QueueActions>
          </li>
        ))}</ul>}
    </div>
  );
}

function ErrorLogsTab({ summary, refresh }: { summary: WorkbenchSummary | null; refresh: () => void }) {
  const logs = summary?.openErrorLogs?.logs ?? [];
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
                <div class="small muted">{log.category} · {log.status} · last seen {new Date(log.lastSeenAt).toLocaleString()} · {log.occurrenceCount} occurrences</div>
              </div>
              <Pill kind={severityKind(log.severity)}>{log.severity}</Pill>
            </div>
            {log.summary && <p class="small">{log.summary}</p>}
            <QueueActions>
              <QueueActionButton path={`/operations/error-logs/${log.id}`} body={{ status: 'triaged' }} queue="Error logs" label="Mark triaged" kind="primary" icon="check" onDone={refresh} />
              <QueueActionButton path={`/operations/error-logs/${log.id}`} body={{ status: 'archived' }} queue="Error logs" label="Archive" kind="danger" icon="archive" onDone={refresh} />
            </QueueActions>
          </li>
        ))}</ul>}
    </div>
  );
}

function QueueActions({ children }: { children: ComponentChildren }) {
  return <div class="queue-actions">{children}</div>;
}

function QueueActionButton({
  path,
  body,
  queue,
  label,
  kind,
  icon,
  onDone,
}: {
  path: string;
  body: Record<string, unknown>;
  queue: string;
  label: string;
  kind: 'primary' | 'warn' | 'danger';
  icon: 'check' | 'x' | 'archive' | 'alert';
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await api(path, { method: 'PATCH', body });
      pushToast(`${queue} queue updated: ${label.toLowerCase()}.`, 'good');
      onDone();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button class={`icon-button ${kind}`} disabled={busy} onClick={run} data-testid={`queue-action-${slug(queue)}-${slug(label)}`}>
      {iconNode(icon)} {busy ? 'Working...' : label}
    </button>
  );
}

function iconNode(icon: 'check' | 'x' | 'archive' | 'alert') {
  if (icon === 'check') return <Check size={14} aria-hidden="true" />;
  if (icon === 'x') return <X size={14} aria-hidden="true" />;
  if (icon === 'archive') return <Archive size={14} aria-hidden="true" />;
  return <CircleAlert size={14} aria-hidden="true" />;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
