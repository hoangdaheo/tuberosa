import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import { KnowledgeItem } from '../viz/KnowledgeItem.js';
import { Term } from '../viz/Term.js';

const LIFECYCLE = [
  { n: 1, label: 'Session ends', detail: 'An agent finishes a task.' },
  { n: 2, label: 'Draft captured', detail: 'Tuberosa drafts a lesson.' },
  { n: 3, label: 'Reviewer approves', detail: 'A human approves it.' },
  { n: 4, label: 'Next agent reads it', detail: 'It ranks first next time.' },
];

export default function Ch06_Reflections() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 6) : undefined), []);
  const [approved, setApproved] = useState(false);

  const reflection = acmeBilling.items.find((i) => i.id === 'mem-migration-step-missed');

  const baseline = [
    { id: 'cr-auth-middleware-001', title: 'authMiddleware', sourceUri: 'src/auth/middleware.ts' },
    { id: 'cr-auth-token-service', title: 'AuthTokenService', sourceUri: 'src/auth/tokens.ts' },
    { id: 'cr-user-service', title: 'UserService', sourceUri: 'src/user/user-service.ts' },
  ];

  return (
    <section id="ch6" class="chapter" data-numeral="06" ref={ref}>
      <span class="overline">Reflections</span>
      <h2 style="margin-top:var(--space-4)">Reflections that learn</h2>
      <p class="lead">
        A <Term k="reflection">reflection</Term> is a reviewed lesson. Approve one and watch the
        next agent's ranking change.
      </p>

      <ol style="margin:var(--space-4) 0 0;padding:0;list-style:none;display:flex;gap:8px;flex-wrap:wrap">
        {LIFECYCLE.map((s) => (
          <li
            key={s.n}
            class="card"
            style={`flex:1;min-width:140px;border-color:${approved && s.n <= 3 ? 'var(--good)' : 'var(--line)'};transition:border-color var(--anim-med)`}
          >
            <span class="overline">step {s.n}</span>
            <strong style="display:block;font-family:var(--font-display);font-weight:500;margin-top:4px">{s.label}</strong>
            <span style="color:var(--paper-3);font-size:var(--fs-small)">{s.detail}</span>
          </li>
        ))}
      </ol>

      <div
        class="card fade-in"
        style={`margin-top:var(--space-4);border-color:${approved ? 'var(--good)' : 'var(--copper-deep)'};transition:border-color var(--anim-med)`}
      >
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3)">
          <strong style="font-family:var(--font-display);font-weight:500;font-size:18px;color:var(--paper-0)">
            {reflection?.title}
          </strong>
          <span class="pill" data-tone={approved ? 'good' : 'warm'}>{approved ? 'approved' : 'draft'}</span>
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
          <ol style="margin:var(--space-3) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">
            {baseline.map((r, i) => (
              <li key={r.id} style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--paper-3);font-variant-numeric:tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <KnowledgeItem id={r.id} title={r.title} itemType="code_ref" sourceUri={r.sourceUri} />
              </li>
            ))}
          </ol>
        </div>
        <div class="card" style={`border-color:${approved ? 'var(--good)' : 'var(--line)'};transition:border-color var(--anim-med)`}>
          <span class="overline">With reviewed memory</span>
          <ol style="margin:var(--space-3) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">
            {approved && (
              <li class="fade-in" style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--sage);font-variant-numeric:tabular-nums">01</span>
                <KnowledgeItem id="mem-migration-step-missed" title="Missed migration step lesson" itemType="memory" />
              </li>
            )}
            {baseline.map((r, i) => (
              <li key={r.id} style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--paper-3);font-variant-numeric:tabular-nums">
                  {String(i + 1 + (approved ? 1 : 0)).padStart(2, '0')}
                </span>
                <KnowledgeItem id={r.id} title={r.title} itemType="code_ref" sourceUri={r.sourceUri} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
