import type { WorkbenchSummary } from '../types.js';

export interface SystemStatusItem {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}

export function presentSystemStatus(summary: WorkbenchSummary | null): SystemStatusItem[] {
  if (!summary) return [{ label: 'status', value: 'loading', tone: 'muted' }];
  return [
    { label: 'store', value: summary.health.store, tone: summary.health.store === 'postgres' ? 'good' : 'warn' },
    { label: 'cache', value: summary.health.cache, tone: 'muted' },
    { label: 'provider', value: summary.health.modelProvider, tone: 'muted' },
    { label: 'backup', value: summary.health.backupStatus.health, tone: summary.health.backupStatus.health === 'ok' ? 'good' : 'warn' },
    { label: 'backups', value: String(summary.health.backupStatus.backupCount), tone: summary.health.backupStatus.backupCount > 0 ? 'good' : 'warn' },
  ];
}
