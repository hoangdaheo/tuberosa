import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import { SignalChips } from '../viz/SignalChips.js';
import { toSignalChips } from '../viz/signal-chips-vm.js';
import { PipelineFlow } from '../viz/PipelineFlow.js';
import { pipelineSteps } from '../viz/pipeline-flow-vm.js';
import { PackTimeline } from '../viz/PackTimeline.js';
import { toPackVM } from '../viz/pack-timeline-vm.js';
import { branchLabel } from '../data/branch-labels.js';
import { FitMeter } from '../viz/FitMeter.js';
import p1 from '../data/demo/replays/p1.json' with { type: 'json' };
import p2 from '../data/demo/replays/p2.json' with { type: 'json' };
import p3 from '../data/demo/replays/p3.json' with { type: 'json' };
import p4 from '../data/demo/replays/p4.json' with { type: 'json' };
import p5 from '../data/demo/replays/p5.json' with { type: 'json' };
import p6 from '../data/demo/replays/p6.json' with { type: 'json' };
import p7 from '../data/demo/replays/p7.json' with { type: 'json' };
import p8 from '../data/demo/replays/p8.json' with { type: 'json' };
import p9 from '../data/demo/replays/p9.json' with { type: 'json' };
import p10 from '../data/demo/replays/p10.json' with { type: 'json' };

interface Replay {
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
  contextFit: { fitStatus: string };
}

const REPLAYS: Record<string, Replay> = {
  p1: p1 as Replay,
  p2: p2 as Replay,
  p3: p3 as Replay,
  p4: p4 as Replay,
  p5: p5 as Replay,
  p6: p6 as Replay,
  p7: p7 as Replay,
  p8: p8 as Replay,
  p9: p9 as Replay,
  p10: p10 as Replay,
};

export default function Ch07_TryIt() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 7) : undefined), []);
  const [active, setActive] = useState<string | null>(null);
  const replay = active ? REPLAYS[active] : null;
  return (
    <section id="ch7" class="chapter" data-numeral="07" ref={ref}>
      <span class="overline">Try it yourself</span>
      <h2 style="margin-top:var(--space-4)">Ten prompts. Every branch.</h2>
      <p class="lead">Click any card to replay it.</p>
      <p style="color:var(--paper-3);font-size:var(--fs-small);margin-top:6px">
        Pills show which branches each prompt exercises — search sources, ranking adjustments, and the fit verdict.
      </p>
      <div class="split-2" style="margin-top:var(--space-4)">
        {acmeBilling.prompts.map((p, idx) => (
          <button
            key={p.id}
            class="card"
            data-selected={active === p.id ? 'true' : undefined}
            onClick={() => setActive(p.id)}
          >
            <div style="display:flex;align-items:baseline;gap:10px">
              <span
                style="font-family:var(--font-display);font-size:14px;color:var(--paper-3);font-variant-numeric:tabular-nums"
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span style="font-family:var(--font-display);font-style:italic;font-size:16px;color:var(--paper-0);line-height:1.4">
                "{p.text}"
              </span>
            </div>
            <div class="row-chips" style="margin-top:10px">
              {p.branches.map((b) => (
                <span key={b} class="pill" data-tone="neutral">
                  {branchLabel(b)}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
      {replay && (
        <div class="split-2" style="margin-top:var(--space-5)">
          <div>
            <h3>Signals</h3>
            <SignalChips chips={toSignalChips(replay.classifier)} />
            <h3 style="margin-top:var(--space-5)">Pipeline</h3>
            <PipelineFlow steps={pipelineSteps(replay.timings.stageMs)} />
          </div>
          <div>
            <h3>Pack</h3>
            <PackTimeline vm={toPackVM(replay.pack)} />
            <div style="margin-top:var(--space-3)">
              <FitMeter
                score={
                  replay.contextFit.fitStatus === 'ready'
                    ? 0.8
                    : replay.contextFit.fitStatus === 'needs_confirmation'
                      ? 0.55
                      : 0.3
                }
                status={replay.contextFit.fitStatus}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
