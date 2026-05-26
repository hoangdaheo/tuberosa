import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { SignalChips } from '../viz/SignalChips.js';
import { toSignalChips } from '../viz/signal-chips-vm.js';
import { PipelineFlow } from '../viz/PipelineFlow.js';
import { pipelineSteps } from '../viz/pipeline-flow-vm.js';
import { PackTimeline } from '../viz/PackTimeline.js';
import { toPackVM } from '../viz/pack-timeline-vm.js';

const TIMINGS = {
  receive: 1,
  classify: 12,
  rewrite: 0,
  search: 38,
  fuse: 5,
  rerank: 22,
  adjust: 3,
  fit: 1,
  assemble: 2,
  deep: 0,
};

export default function Ch03_Anatomy() {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const stop = observeChapter(ref.current, 3);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          if (reduce) {
            setShown(3);
            return;
          }
          setShown(1);
          setTimeout(() => setShown(2), 500);
          setTimeout(() => setShown(3), 2000);
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(ref.current);
    return () => {
      stop();
      io.disconnect();
    };
  }, []);

  const chips = toSignalChips({
    symbols: ['paywall', 'logic'],
    errors: [],
    files: [],
    businessAreas: ['subscription'],
    technologies: [],
    taskType: 'research',
  });
  const steps = pipelineSteps(TIMINGS);
  const pack = toPackVM({
    essential: [{ id: 'cr-paywall-001', title: 'PaywallSelectionModal', tokens: 220 }],
    supporting: [{ id: 'spec-subscription-tiers', title: 'Subscription tiers', tokens: 180 }],
    optional: [],
  });
  return (
    <section id="ch3" class="chapter" ref={ref}>
      <h2>Anatomy of a session</h2>
      <p class="lead">One prompt, ~80ms, three groups of context.</p>
      <div class="card" style="margin-top:16px">
        <strong>Prompt</strong> · "Where does paywall logic live?"
      </div>
      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <h3>Signals</h3>
          {shown >= 1 && <SignalChips chips={chips} />}
          <h3 style="margin-top:16px">Pipeline</h3>
          {shown >= 2 && <PipelineFlow steps={steps} />}
        </div>
        <div>
          <h3>Pack</h3>
          {shown >= 3 && <PackTimeline vm={pack} />}
        </div>
      </div>
    </section>
  );
}
