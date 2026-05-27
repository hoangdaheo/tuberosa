export type FitStatus = 'ready' | 'needs_confirmation' | 'insufficient';

export interface FitThresholds {
  needsConfirmation: number;
  ready: number;
}

export const DEFAULT_FIT_THRESHOLDS: FitThresholds = { needsConfirmation: 0.45, ready: 0.72 };

const LABELS: Record<FitStatus, string> = {
  ready: 'ready',
  needs_confirmation: 'needs confirmation',
  insufficient: 'insufficient',
};

export function fitStatusFromScore(score: number, t: FitThresholds): FitStatus {
  if (score >= t.ready) return 'ready';
  if (score >= t.needsConfirmation) return 'needs_confirmation';
  return 'insufficient';
}

export interface FitMeterVM {
  percent: number;
  status: FitStatus;
  label: string;
  thresholds: FitThresholds;
  missing: string[];
}

export function fitMeterVM(input: {
  score: number;
  status?: FitStatus | string;
  thresholds?: FitThresholds;
  missing?: string[];
}): FitMeterVM {
  const thresholds = input.thresholds ?? DEFAULT_FIT_THRESHOLDS;
  const percent = Math.max(0, Math.min(100, input.score * 100));
  const status =
    (input.status as FitStatus) && LABELS[input.status as FitStatus]
      ? (input.status as FitStatus)
      : fitStatusFromScore(input.score, thresholds);
  return { percent, status, label: LABELS[status], thresholds, missing: input.missing ?? [] };
}
