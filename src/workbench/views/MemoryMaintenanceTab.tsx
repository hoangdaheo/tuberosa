import { useEffect, useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import { EmptyState } from '../components/EmptyState.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';
import { Pill } from '../components/Pill.js';
import type {
  MaintenanceApplyResult,
  MaintenanceBatch,
  MaintenanceItem,
  MaintenanceItemKind,
  MaintenanceRisk,
} from '../types.js';

interface Props {
  project: string;
  refresh: () => void;
}

const KIND_LABELS: Record<MaintenanceItemKind, string> = {
  duplicate_memory: 'Duplicate memories',
  stale_relation: 'Stale relations',
  superseded_reflection: 'Superseded reflections',
  weak_label: 'Weak labels',
};

export function MemoryMaintenanceTab({ project, refresh }: Props) {
  const [batch, setBatch] = useState<MaintenanceBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const next = await api<MaintenanceBatch>('/operations/maintenance/preview', {
        method: 'POST',
        body: { project: project || undefined, limit: 100 },
      });
      setBatch(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { load(); }, [project]);

  async function applyItem(item: MaintenanceItem) {
    if (!batch) return;
    setBusyId(item.id);
    try {
      const result = await api<MaintenanceApplyResult>('/operations/maintenance/apply', {
        method: 'POST',
        body: { batchId: batch.id, approvedItemIds: [item.id] },
      });
      reportApply(result);
      await load();
      refresh();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusyId(null);
    }
  }

  async function applyAllLowRisk() {
    if (!batch) return;
    setBulkBusy(true);
    try {
      const result = await api<MaintenanceApplyResult>('/operations/maintenance/apply', {
        method: 'POST',
        body: { batchId: batch.id, autoApplyLowRisk: true },
      });
      reportApply(result);
      await load();
      refresh();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBulkBusy(false);
    }
  }

  if (error) return <div class="panel"><div class="card bad">Error loading maintenance preview: {error}</div></div>;
  if (batch === null) return <div class="panel"><p class="muted">Loading maintenance preview…</p></div>;

  const grouped = groupByKind(batch.items);
  const lowRiskCount = batch.items.filter((i) => i.risk === 'low').length;

  return (
    <div class="panel" data-testid="maintenance-tab">
      <div class="row between" style={{ marginBottom: 12 }}>
        <h3><GlossaryTerm termKey="maintenance_preview">Maintenance preview</GlossaryTerm></h3>
        <div class="row">
          <Pill kind="muted">batch {batch.id.slice(0, 8)}</Pill>
          <Pill kind="muted">{batch.totalDetected} detected{batch.truncated ? ' (truncated)' : ''}</Pill>
          <button
            class="primary"
            disabled={bulkBusy || lowRiskCount === 0}
            data-testid="maintenance-apply-low-risk"
            onClick={applyAllLowRisk}
          >
            {bulkBusy ? 'Working…' : `Apply low-risk (${lowRiskCount})`}
          </button>
          <button onClick={load}>Refresh</button>
        </div>
      </div>
      <p class="muted small">
        Reviewer-only: nothing mutates until you press Apply on an item or the low-risk bulk button.
      </p>

      {batch.items.length === 0
        ? <EmptyState title="No maintenance items detected." hint="Tuberosa scans for duplicates, stale relations, supersessions, and weak labels." />
        : (Object.keys(grouped) as MaintenanceItemKind[])
          .filter((kind) => grouped[kind].length > 0)
          .map((kind) => (
            <section key={kind} data-testid={`maintenance-group-${kind}`}>
              <h4 class="row" style={{ alignItems: 'center', gap: 8 }}>
                {KIND_LABELS[kind]}
                <Pill kind="muted">{grouped[kind].length}</Pill>
              </h4>
              <ul class="bare">
                {grouped[kind].map((item) => (
                  <MaintenanceItemCard
                    key={item.id}
                    item={item}
                    busy={busyId === item.id}
                    onApply={() => applyItem(item)}
                  />
                ))}
              </ul>
            </section>
          ))
      }
    </div>
  );
}

function MaintenanceItemCard({
  item,
  busy,
  onApply,
}: {
  item: MaintenanceItem;
  busy: boolean;
  onApply: () => void;
}) {
  return (
    <li class="card">
      <div class="card-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div class="card-title">{item.reason}</div>
          <div class="small muted">
            {item.knowledgeId && <>knowledge <code>{item.knowledgeId}</code></>}
            {item.relationId && <>relation <code>{item.relationId}</code></>}
            {item.reflectionDraftId && <>draft <code>{item.reflectionDraftId}</code></>}
            {item.label && <> · label {item.label.type}=<code>{item.label.value}</code></>}
          </div>
        </div>
        <Pill kind={riskKind(item.risk)} title={`Risk: ${item.risk}`}>{item.risk}</Pill>
      </div>
      {item.before && <MaintenanceBeforeBlock before={item.before} />}
      {item.evidence && item.evidence.length > 0 && (
        <ul class="bullets small muted" data-testid={`maintenance-evidence-${item.id}`}>
          {item.evidence.slice(0, 4).map((entry, i) => (
            <li key={i}><Pill kind="muted">{entry.source}</Pill> <code>{entry.reference}</code></li>
          ))}
        </ul>
      )}
      <div class="queue-actions">
        <button
          class="icon-button primary"
          disabled={busy}
          data-testid={`maintenance-apply-${item.id}`}
          onClick={onApply}
        >
          {busy ? 'Working…' : 'Apply'}
        </button>
      </div>
    </li>
  );
}

function MaintenanceBeforeBlock({ before }: { before: NonNullable<MaintenanceItem['before']> }) {
  if (!before.title && !before.summary && (!before.labels || before.labels.length === 0)) return null;
  return (
    <div class="small" style={{ marginTop: 4 }}>
      <strong>Before:</strong>{' '}
      {before.title && <code>{before.title}</code>}
      {before.status && <> · status <Pill kind="muted">{before.status}</Pill></>}
      {before.summary && <div class="muted">{before.summary}</div>}
      {before.labels && before.labels.length > 0 && (
        <div class="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {before.labels.slice(0, 6).map((l, i) => (
            <Pill key={i} kind="muted">{l.type}: {l.value}</Pill>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByKind(items: MaintenanceItem[]): Record<MaintenanceItemKind, MaintenanceItem[]> {
  const out: Record<MaintenanceItemKind, MaintenanceItem[]> = {
    duplicate_memory: [],
    stale_relation: [],
    superseded_reflection: [],
    weak_label: [],
  };
  for (const item of items) out[item.kind].push(item);
  return out;
}

function riskKind(risk: MaintenanceRisk): 'good' | 'warn' | 'bad' {
  if (risk === 'low') return 'good';
  if (risk === 'medium') return 'warn';
  return 'bad';
}

function reportApply(result: MaintenanceApplyResult): void {
  const parts: string[] = [`applied ${result.appliedCount}`];
  if (result.expiredCount) parts.push(`expired ${result.expiredCount}`);
  if (result.skippedCount) parts.push(`skipped ${result.skippedCount}`);
  if (result.failedCount) parts.push(`failed ${result.failedCount}`);
  const kind: 'bad' | 'good' | 'info' = result.failedCount > 0
    ? 'bad'
    : result.appliedCount > 0
      ? 'good'
      : 'info';
  pushToast(`Maintenance: ${parts.join(' · ')}`, kind);
}
