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
    <section id="ch6" class="chapter" ref={ref}>
      <h2>Reflections that learn</h2>
      <p class="lead">
        After a session ends, Tuberosa can save a reviewed lesson. The next agent reads it first.
      </p>
      <div
        class="card fade-in"
        style={`margin-top:16px;border-color:${approved ? 'var(--good)' : 'var(--accent-warm)'};transition:border-color var(--anim-med)`}
      >
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>{reflection?.title}</strong>
          <span class="pill" data-tone={approved ? '' : 'warm'}>
            {approved ? 'approved' : 'draft'}
          </span>
        </div>
        <p style="color:var(--fg-muted);font-size:14px;margin-top:8px">
          {reflection?.content.slice(0, 220)}…
        </p>
        {!approved && (
          <button class="primary" style="margin-top:8px" onClick={() => setApproved(true)}>
            Approve
          </button>
        )}
      </div>
      <h3 style="margin-top:24px">Before & after on the same prompt</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px">
        <div class="card">
          <strong>Without memory</strong>
          <ol style="margin:8px 0 0;padding-left:18px">
            {without.map((r) => (
              <li key={r.id}>
                <span class="code">{r.id}</span> {r.title}
              </li>
            ))}
          </ol>
        </div>
        <div class="card" style={`border-color:${approved ? 'var(--good)' : 'var(--line)'}`}>
          <strong>With reviewed memory</strong>
          <ol style="margin:8px 0 0;padding-left:18px">
            {withMem.map((r) => (
              <li key={r.id} style={r.id === 'mem-migration-step-missed' ? 'color:var(--good)' : ''}>
                <span class="code">{r.id}</span> {r.title}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
