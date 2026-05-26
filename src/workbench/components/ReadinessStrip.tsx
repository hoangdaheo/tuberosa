import { AlertTriangle, CheckCircle2, Database, KeyRound } from 'lucide-preact';
import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { Pill } from './Pill.js';

interface Props {
  summary: SummaryViewModel | null;
  apiKeySet: boolean;
  loading: boolean;
}

export function ReadinessStrip({ summary, apiKeySet, loading }: Props) {
  const warning = summary?.health.warning;
  const Icon = warning ? AlertTriangle : CheckCircle2;
  return (
    <section class="readiness-strip" data-testid="readiness-strip" aria-label="Workbench readiness">
      <div>
        <Icon size={17} aria-hidden="true" />
        <span>{loading ? 'Checking Tuberosa...' : summary?.health.line ?? 'Connect to Tuberosa to inspect readiness.'}</span>
      </div>
      <div class="readiness-pills">
        <Pill kind={warning ? 'warn' : 'good'}><Database size={12} aria-hidden="true" /> {warning ? 'ephemeral' : 'persistent'}</Pill>
        <Pill kind={apiKeySet ? 'good' : 'muted'}><KeyRound size={12} aria-hidden="true" /> {apiKeySet ? 'API key set' : 'loopback/dev'}</Pill>
      </div>
    </section>
  );
}
