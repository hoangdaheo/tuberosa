import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { startTour } from '../shell/AutoTour.js';

export default function Ch01_Hello() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 1) : undefined), []);
  return (
    <section id="ch1" class="chapter" data-numeral="01" ref={ref}>
      <span class="overline">Chapter One</span>
      <h2 class="fade-in" style="margin-top:var(--space-4)">
        Tuberosa is a context broker for coding agents.
      </h2>
      <p class="lead fade-in" style="animation-delay:120ms">
        It sits between your agent and your project knowledge. It retrieves the right references for
        the task, captures reviewed lessons, and feeds both back in.
      </p>
      <svg
        viewBox="0 0 600 140"
        width="100%"
        style="max-width:720px;margin-top:var(--space-5)"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="ar"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {([
          [60, 'Agent'],
          [300, 'Tuberosa'],
          [540, 'Knowledge'],
        ] as Array<[number, string]>).map(([x, label], i) => (
          <g key={label}>
            <rect
              x={x - 64}
              y={44}
              width={128}
              height={52}
              rx={10}
              fill="var(--ink-1)"
              stroke="var(--line)"
            />
            <text
              x={x}
              y={70}
              text-anchor="middle"
              fill="var(--paper-0)"
              font-family="var(--font-display)"
              font-size="17"
              font-weight="500"
            >
              {label}
            </text>
            <text
              x={x}
              y={86}
              text-anchor="middle"
              fill="var(--paper-3)"
              font-family="var(--font-mono)"
              font-size="9"
              letter-spacing="0.12em"
            >
              {['CALLER', 'BROKER', 'TRUTH'][i]}
            </text>
          </g>
        ))}
        <path
          d="M124,70 L236,70"
          stroke="var(--copper)"
          stroke-width="1.5"
          marker-end="url(#ar)"
          style="stroke-dasharray:6;animation:dash 3s linear infinite"
        />
        <path
          d="M364,70 L476,70"
          stroke="var(--terracotta)"
          stroke-width="1.5"
          marker-end="url(#ar)"
          style="stroke-dasharray:6;animation:dash 3s linear infinite reverse"
        />
        <style>{`@keyframes dash{to{stroke-dashoffset:-24}}@media (prefers-reduced-motion: reduce){path{animation:none}}`}</style>
      </svg>
      <div style="margin-top:var(--space-6);display:flex;gap:var(--space-3);align-items:center">
        <button
          class="primary"
          onClick={() => {
            startTour();
          }}
        >
          Start the tour →
        </button>
        <span style="color:var(--paper-3);font-size:var(--fs-small)">
          Or just scroll. Ten short chapters.
        </span>
      </div>
    </section>
  );
}
