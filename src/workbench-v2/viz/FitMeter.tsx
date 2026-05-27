import { fitMeterVM, type FitStatus, type FitThresholds } from './fit-meter-vm.js';

const TONE: Record<FitStatus, string> = {
  ready: 'good',
  needs_confirmation: 'warm',
  insufficient: 'bad',
};

export function FitMeter({
  score,
  status,
  thresholds,
  missing,
}: {
  score: number;
  status?: FitStatus | string;
  thresholds?: FitThresholds;
  missing?: string[];
}) {
  const vm = fitMeterVM({ score, status, thresholds, missing });
  const ncLeft = Math.min(100, vm.thresholds.needsConfirmation * 100);
  const readyLeft = Math.min(100, vm.thresholds.ready * 100);
  return (
    <div class="card" style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
        <span class="overline">fit score</span>
        <span class="pill" data-tone={TONE[vm.status]}>{vm.label}</span>
      </div>
      <div style="position:relative;height:10px;background:var(--ink-2);border-radius:5px;margin-top:12px">
        <div style={`position:absolute;inset:0;width:${vm.percent}%;background:linear-gradient(90deg,var(--copper),var(--terracotta));border-radius:5px`} />
        <span aria-hidden="true" style={`position:absolute;top:-4px;bottom:-4px;left:${ncLeft}%;width:1px;background:var(--paper-3)`} />
        <span aria-hidden="true" style={`position:absolute;top:-4px;bottom:-4px;left:${readyLeft}%;width:1px;background:var(--paper-1)`} />
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;color:var(--paper-3);font-size:var(--fs-overline);letter-spacing:0.06em">
        <span>insufficient</span>
        <span>needs confirmation</span>
        <span>ready</span>
      </div>
      <div style="margin-top:10px;color:var(--paper-2);font-size:var(--fs-small)">
        score {vm.percent.toFixed(0)} / 100
      </div>
      <div style="margin-top:6px;color:var(--paper-3);font-size:var(--fs-small)">
        {vm.missing.length === 0 ? 'missing: none' : `missing: ${vm.missing.join(', ')}`}
      </div>
    </div>
  );
}
