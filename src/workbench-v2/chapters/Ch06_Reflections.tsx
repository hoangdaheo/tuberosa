import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';

export default function Ch06_Reflections() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 6) : undefined), []);
  const [approved, setApproved] = useState(false);

  const reflection = acmeBilling.items.find((i) => i.id === 'mem-migration-step-missed');

  // Before: ranking without the memory boost.
  const without = [
    { id: 'cr-auth-middleware-001', title: 'authMiddleware in src/auth/middleware.ts', rank: 1 },
    { id: 'cr-auth-token-service', title: 'AuthTokenService in src/auth/tokens.ts', rank: 2 },
    { id: 'cr-user-service', title: 'UserService in src/user/user-service.ts', rank: 3 },
  ];
  // After: same prompt with the migration-step-missed memory applied.
  const withMem = [
    { id: 'mem-migration-step-missed', title: 'Missed migration step lesson', rank: 1 },
    { id: 'cr-auth-middleware-001', title: 'authMiddleware in src/auth/middleware.ts', rank: 2 },
    { id: 'cr-auth-token-service', title: 'AuthTokenService in src/auth/tokens.ts', rank: 3 },
  ];

  return (
    <section id="ch6" class="chapter" data-numeral="06" ref={ref}>
      <span class="overline">Reflections</span>
      <h2 style="margin-top:var(--space-4)">Reflections that learn</h2>
      <p class="lead">
        After a session ends, Tuberosa can save a reviewed lesson. The next agent reads it first.
      </p>
      <div
        class="card fade-in"
        style={`margin-top:var(--space-4);border-color:${approved ? 'var(--good)' : 'var(--copper-deep)'};transition:border-color var(--anim-med)`}
      >
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3)">
          <strong
            style="font-family:var(--font-display);font-weight:500;font-size:18px;color:var(--paper-0)"
          >
            {reflection?.title}
          </strong>
          <span class="pill" data-tone={approved ? 'good' : 'warm'}>
            {approved ? 'approved' : 'draft'}
          </span>
        </div>
        <p style="color:var(--paper-2);font-size:var(--fs-small);margin-top:var(--space-2);line-height:1.55">
          {reflection?.content.slice(0, 220)}…
        </p>
        {!approved && (
          <button class="primary" style="margin-top:var(--space-3)" onClick={() => setApproved(true)}>
            Approve reflection
          </button>
        )}
      </div>
      <h3 style="margin-top:var(--space-6)">Before & after on the same prompt</h3>
      <div class="split-2" style="margin-top:var(--space-2)">
        <div class="card">
          <span class="overline">Without memory</span>
          <ol style="margin:var(--space-3) 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px;counter-reset:rk">
            {without.map((r) => (
              <li
                key={r.id}
                style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline;counter-increment:rk;color:var(--paper-1);font-size:var(--fs-small)"
              >
                <span
                  style="font-family:var(--font-display);color:var(--paper-3);font-variant-numeric:tabular-nums"
                >
                  {String(r.rank).padStart(2, '0')}
                </span>
                <span>
                  <span class="code">{r.id}</span> {r.title}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div
          class="card"
          style={`border-color:${approved ? 'var(--good)' : 'var(--line)'};transition:border-color var(--anim-med)`}
        >
          <span class="overline">With reviewed memory</span>
          <ol style="margin:var(--space-3) 0 0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px">
            {withMem.map((r) => {
              const isMem = r.id === 'mem-migration-step-missed';
              return (
                <li
                  key={r.id}
                  style={`display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline;color:${isMem ? 'var(--sage)' : 'var(--paper-1)'};font-size:var(--fs-small)`}
                >
                  <span
                    style={`font-family:var(--font-display);color:${isMem ? 'var(--sage)' : 'var(--paper-3)'};font-variant-numeric:tabular-nums`}
                  >
                    {String(r.rank).padStart(2, '0')}
                  </span>
                  <span>
                    <span class="code">{r.id}</span> {r.title}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
