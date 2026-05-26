import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { setRoute, route } from '../state/store.js';

export default function Ch01_Hello() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 1) : undefined), []);
  return (
    <section id="ch1" class="chapter" ref={ref}>
      <h2 class="fade-in">Tuberosa is a context broker for coding agents.</h2>
      <p class="lead fade-in" style="animation-delay:120ms">
        It sits between your agent and your project knowledge. It retrieves the right references for
        the task, captures reviewed lessons, and feeds both back in.
      </p>
      <svg
        viewBox="0 0 600 120"
        width="100%"
        style="max-width:720px;margin-top:24px"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="ar"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {([
          [60, 'Agent'],
          [300, 'Tuberosa'],
          [540, 'Knowledge'],
        ] as Array<[number, string]>).map(([x, label]) => (
          <g key={label}>
            <rect
              x={x - 60}
              y={36}
              width={120}
              height={48}
              rx={10}
              fill="var(--bg-elev)"
              stroke="var(--line)"
            />
            <text x={x} y={66} text-anchor="middle" fill="var(--fg)" font-size="14">
              {label}
            </text>
          </g>
        ))}
        <path
          d="M120,60 L240,60"
          stroke="var(--accent)"
          stroke-width="2"
          marker-end="url(#ar)"
          style="stroke-dasharray:8;animation:dash 3s linear infinite"
        />
        <path
          d="M360,60 L480,60"
          stroke="var(--accent-warm)"
          stroke-width="2"
          marker-end="url(#ar)"
          style="stroke-dasharray:8;animation:dash 3s linear infinite reverse"
        />
        <style>{`@keyframes dash{to{stroke-dashoffset:-32}}@media (prefers-reduced-motion: reduce){path{animation:none}}`}</style>
      </svg>
      <div style="margin-top:24px;display:flex;gap:12px">
        <button
          class="primary"
          onClick={() => {
            setRoute({ ...route.value, chapter: 2 });
            document.getElementById('ch2')?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          Start the tour →
        </button>
      </div>
    </section>
  );
}
