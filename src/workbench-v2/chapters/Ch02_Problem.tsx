import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';

export default function Ch02_Problem() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 2) : undefined), []);
  const cited = acmeBilling.items.find((i) => i.id === 'cr-paywall-001');
  return (
    <section id="ch2" class="chapter" ref={ref}>
      <h2>Same agent. Same prompt. Two answers.</h2>
      <p class="lead">Left: without Tuberosa. Right: with Tuberosa.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
        <div class="card">
          <p class="pill" data-tone="bad">without</p>
          <p>
            <strong>You:</strong> Where does paywall logic live?
          </p>
          <p class="fade-in">
            <strong>Agent:</strong> I'm not sure — try grepping for "paywall" or "checkout"…
          </p>
        </div>
        <div class="card">
          <p class="pill">with</p>
          <p>
            <strong>You:</strong> Where does paywall logic live?
          </p>
          <p class="fade-in">
            <strong>Agent:</strong> It's <span class="code">{cited?.title}</span> at{' '}
            <span class="code">{cited?.sourceUri}</span>. The tier picker is rendered from there.
          </p>
        </div>
      </div>
    </section>
  );
}
