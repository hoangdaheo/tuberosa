import { TERMS, categoryLabel, categoryOrder, termKeys, type TermKey } from '../glossary/terms.js';
import { GlossaryTerm } from '../components/GlossaryTerm.js';

export function GuideView() {
  const byCategory = new Map<string, TermKey[]>();
  for (const key of termKeys()) {
    const cat = TERMS[key].category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(key);
  }

  return (
    <section data-testid="guide-view" class="stack">
      <div class="panel guide-doc">
        <h1>Beginner Guide</h1>
        <p class="muted">
          Tuberosa is a <GlossaryTerm termKey="context_broker">context broker</GlossaryTerm>. It chooses the
          project knowledge an agent should read before work starts, then keeps the review queues honest so
          new lessons become trusted only after a decision.
        </p>
        <div class="flow-map" aria-label="Tuberosa flow map">
          {[
            ['Prompt', 'An agent starts with a task and local project clues.'],
            ['Broker', 'Tuberosa classifies the request and searches reviewed knowledge.'],
            ['Context pack', 'The broker returns compact essential, supporting, and optional context.'],
            ['Decision', 'The agent records whether the context was useful, noisy, stale, or missing.'],
            ['Reviewed memory', 'Lessons, gaps, conflicts, and incidents wait here until a reviewer acts.'],
          ].map(([title, text], i) => (
            <div class="flow-node" key={title}>
              <span class="flow-index">{i + 1}</span>
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>

        <h2>What Tuberosa does</h2>
        <p>
          It stores specs, workflows, code references, incident lessons, and approved memories as{' '}
          <GlossaryTerm termKey="knowledge_item">knowledge items</GlossaryTerm>. Each item carries{' '}
          <GlossaryTerm termKey="label">labels</GlossaryTerm>, <GlossaryTerm termKey="reference">references</GlossaryTerm>,{' '}
          <GlossaryTerm termKey="trust_level">trust</GlossaryTerm>, and <GlossaryTerm termKey="freshness">freshness</GlossaryTerm>
          so retrieval can prefer concrete evidence over generic semantic matches.
        </p>
        <p>
          When a task arrives, the broker returns a <GlossaryTerm termKey="context_pack">context pack</GlossaryTerm>
          with a <GlossaryTerm termKey="context_fit">context fit</GlossaryTerm> verdict. The workbench exists to
          operate the review loop around those packs, not to edit database rows by hand.
        </p>

        <h2>How agents should use it</h2>
        <ol class="bullets">
          <li>Start an <GlossaryTerm termKey="agent_session">agent session</GlossaryTerm> before substantial work.</li>
          <li>Read the task brief, direct evidence, missing signals, and verification commands.</li>
          <li>Record a <GlossaryTerm termKey="context_decision">context decision</GlossaryTerm> before continuing.</li>
          <li>Finish the session with outcome, summary, and any useful <GlossaryTerm termKey="learning_signal">learning signals</GlossaryTerm>.</li>
          <li>Review the resulting <GlossaryTerm termKey="reflection_draft">reflection draft</GlossaryTerm> before it becomes memory.</li>
        </ol>

        <h2>What each queue means</h2>
        <div class="queue-guide">
          <div><strong>Pending drafts</strong><span>Proposed lessons waiting for approve, needs changes, or reject.</span></div>
          <div><strong>Context quality</strong><span>Feedback that says context was noisy, stale, rejected, or missing.</span></div>
          <div><strong>Gaps</strong><span>Missing evidence agents could not find and a reviewer may need to ingest.</span></div>
          <div><strong>Proposals</strong><span>Suggested label, reference, relation, supersession, or memory cleanup.</span></div>
          <div><strong>Conflicts</strong><span>Knowledge items that disagree and need resolve or dismiss.</span></div>
          <div><strong>Risky memories</strong><span>Auto-approved lessons that still deserve audit.</span></div>
          <div><strong>Error logs</strong><span>Captured failures that can become reviewed bugfix lessons.</span></div>
        </div>

        <h2>Retrieval internals</h2>
        <p>
          When an agent asks for help, Tuberosa{' '}
          <GlossaryTerm termKey="classify">classifies</GlossaryTerm> the prompt into structured signals and searches
          in parallel across metadata, <GlossaryTerm termKey="fts">FTS</GlossaryTerm> (lexical),{' '}
          <GlossaryTerm termKey="pgvector">pgvector</GlossaryTerm> (semantic), and approved{' '}
          <GlossaryTerm termKey="memory">memories</GlossaryTerm>. The results are fused with{' '}
          <GlossaryTerm termKey="rrf">reciprocal rank fusion</GlossaryTerm>,{' '}
          <GlossaryTerm termKey="rerank">reranked</GlossaryTerm>, and adjusted by feedback history (penalising{' '}
          <GlossaryTerm termKey="stale">stale</GlossaryTerm> and{' '}
          <GlossaryTerm termKey="superseded">superseded</GlossaryTerm> items via{' '}
          <GlossaryTerm termKey="intent_suppression">intent suppression</GlossaryTerm>).
        </p>
        <p>
          The result is a <GlossaryTerm termKey="context_pack">context pack</GlossaryTerm> with three budgets:{' '}
          <GlossaryTerm termKey="essential_section">essential</GlossaryTerm>,{' '}
          <GlossaryTerm termKey="supporting_section">supporting</GlossaryTerm>, and{' '}
          <GlossaryTerm termKey="optional_section">optional</GlossaryTerm>, plus a{' '}
          <GlossaryTerm termKey="task_brief">task brief</GlossaryTerm> and a{' '}
          <GlossaryTerm termKey="context_fit">context fit</GlossaryTerm> verdict.
        </p>
        <h2>Review and approve</h2>
        <p>
          The <GlossaryTerm termKey="learning_gate">learning gate</GlossaryTerm> evaluates each draft against 11
          quality signals. If every gate passes the draft is auto-approved into{' '}
          <GlossaryTerm termKey="memory">memory</GlossaryTerm>; otherwise it lands here in the workbench for
          human review. The recommendation panel surfaces every gate as a pro, con, or blocker so you can decide
          quickly.
        </p>

        <h2>Frequently asked</h2>
        <p><strong>What happens when I approve a draft?</strong> The draft is ingested as a knowledge item with trust level 85 and source <code>reflection://draft/&lt;id&gt;</code>. It immediately becomes searchable for future tasks.</p>
        <p><strong>Should I trust the recommendation?</strong> The recommendation derives from objective signals — duplicates, grounded references, confidence scores, session outcome. It is a strong default but not a substitute for reading the lesson and judging whether it generalises.</p>
        <p><strong>What if I disagree with a blocker?</strong> Click "Approve anyway" — the workbench will ask you to confirm. Blockers exist to catch likely mistakes; human override is intentional in the design.</p>
      </div>

      <div class="panel guide-doc">
        <h1>Glossary</h1>
        {categoryOrder().map((cat) => (
          <div key={cat} style={{ marginTop: 16 }}>
            <h2>{categoryLabel(cat)}</h2>
            <div class="glossary-grid">
              {(byCategory.get(cat) ?? []).map((key) => {
                const term = TERMS[key];
                return (
                  <div class="glossary-card" id={`term-${key}`} key={key} data-testid={`glossary-${key}`}>
                    <div class="term-name">{term.label}</div>
                    <div class="term-short">{term.short}</div>
                    <p class="small" style={{ marginTop: 8 }}>{term.long}</p>
                    {term.example && <div class="term-example">Example: {term.example}</div>}
                    {term.seeAlso && term.seeAlso.length > 0 && (
                      <div class="term-related">See also: {term.seeAlso.map((t, i) => (
                        <span key={t}>{i > 0 && ', '}<a href={`#term-${t}`}>{TERMS[t].label.toLowerCase()}</a></span>
                      ))}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
