import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';

export default function Ch02_Problem() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 2) : undefined), []);
  const cited = acmeBilling.items.find((i) => i.id === 'cr-paywall-001');
  return (
    <section id="ch2" class="chapter" data-numeral="02" ref={ref}>
      <span class="overline">The problem</span>
      <h2 style="margin-top:var(--space-4)">Same agent. Same prompt. Two answers.</h2>
      <p class="lead">Left: without Tuberosa. Right: with Tuberosa.</p>
      <div class="split-2" style="margin-top:var(--space-4)">
        <div class="card">
          <span class="pill" data-tone="bad">without</span>
          <p style="margin-top:12px">
            <strong style="color:var(--paper-1)">You</strong>
            <span style="color:var(--paper-3)"> · </span>Where does paywall logic live?
          </p>
          <p class="fade-in" style="color:var(--paper-2)">
            <strong style="color:var(--paper-1)">Agent</strong>
            <span style="color:var(--paper-3)"> · </span>I'm not sure — try grepping for "paywall"
            or "checkout"…
          </p>
        </div>
        <div class="card" style="border-color:var(--copper-deep)">
          <span class="pill">with</span>
          <p style="margin-top:12px">
            <strong style="color:var(--paper-1)">You</strong>
            <span style="color:var(--paper-3)"> · </span>Where does paywall logic live?
          </p>
          <p class="fade-in" style="color:var(--paper-1)">
            <strong style="color:var(--paper-1)">Agent</strong>
            <span style="color:var(--paper-3)"> · </span>
            It's <span class="code">{cited?.title}</span> at{' '}
            <span class="code">{cited?.sourceUri}</span>. The tier picker is rendered from there.
          </p>
        </div>
      </div>
    </section>
  );
}
