import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { api } from '../data/api.js';
import { apiKey, currentProject, setApiKey } from '../state/store.js';

interface WorkbenchSummary {
  counts: Record<string, number>;
  storeMode?: string;
  cacheMode?: string;
  modelProvider?: string;
  durability?: string;
  recentSessions?: Array<{ id: string; prompt?: string }>;
  pendingDrafts?: Array<{ id: string; title?: string }>;
  openConflicts?: Array<{ id: string; title?: string }>;
  openGaps?: Array<{ id: string; title?: string }>;
  openProposals?: Array<{ id: string; title?: string }>;
  openErrorLogs?: { totalMatched?: number };
  backupStatus?: { backupCount?: number; lastBackupAt?: string };
}

export default function Ch10_TuneOps() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 10) : undefined), []);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [project, setProject] = useState(currentProject.value);
  const [limit, setLimit] = useState(10);

  function refresh(): void {
    setLoading(true);
    api<WorkbenchSummary>('/operations/workbench/summary', { query: { project, limit } })
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open]);

  return (
    <section id="ch10" class="chapter" ref={ref}>
      <h2>Tune & operate</h2>
      <p class="lead">Review queues, system status, and your operator knobs.</p>
      <details
        open={open}
        onToggle={(e: Event) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        style="margin-top:16px"
      >
        <summary style="cursor:pointer">Open the operator panel</summary>
        {loading && <div style="margin-top:8px">Loading summary…</div>}
        {summary && (
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:16px">
            <div class="card">
              <h3 style="margin-top:0">Review</h3>
              <Row label="pending drafts" n={summary.counts?.pendingDrafts ?? 0} />
              <Row label="open conflicts" n={summary.counts?.openConflicts ?? 0} />
              <Row label="open knowledge gaps" n={summary.counts?.openGaps ?? 0} />
              <Row label="learning proposals" n={summary.counts?.openProposals ?? 0} />
              <Row label="risky auto-memories" n={summary.counts?.riskyAutoMemories ?? 0} />
            </div>
            <div class="card">
              <h3 style="margin-top:0">System</h3>
              <Row label="store" v={summary.storeMode ?? '—'} />
              <Row label="cache" v={summary.cacheMode ?? '—'} />
              <Row label="model" v={summary.modelProvider ?? '—'} />
              <Row label="durability" v={summary.durability ?? '—'} />
              <Row label="open error logs" n={summary.openErrorLogs?.totalMatched ?? 0} />
              <Row label="backups" n={summary.backupStatus?.backupCount ?? 0} />
            </div>
            <div class="card">
              <h3 style="margin-top:0">Feedback knobs</h3>
              <label style="display:block;font-size:12px;margin-bottom:4px">project</label>
              <input
                value={project}
                onInput={(e: Event) => setProject((e.currentTarget as HTMLInputElement).value)}
                onChange={() => {
                  currentProject.value = project;
                }}
                style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px"
              />
              <label style="display:block;font-size:12px;margin:8px 0 4px">api key</label>
              <input
                type="password"
                value={apiKey.value}
                onInput={(e: Event) => setApiKey((e.currentTarget as HTMLInputElement).value)}
                style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px"
              />
              <label style="display:block;font-size:12px;margin:8px 0 4px">result limit</label>
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onInput={(e: Event) => {
                  const n = Number((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(n) && n > 0) setLimit(n);
                }}
                style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px"
              />
              <button class="primary" style="margin-top:12px" onClick={refresh}>
                Refresh
              </button>
            </div>
          </div>
        )}
      </details>
    </section>
  );
}

function Row({ label, n, v }: { label: string; n?: number; v?: string }) {
  return (
    <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line);font-size:13px">
      <span style="color:var(--fg-muted)">{label}</span>
      <span class="code">{v ?? String(n ?? 0)}</span>
    </div>
  );
}
