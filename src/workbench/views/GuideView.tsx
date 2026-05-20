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
        <h1>How Tuberosa works</h1>
        <p class="muted">
          Tuberosa is a <GlossaryTerm termKey="context_broker">context broker</GlossaryTerm> — a service that sits
          between coding agents and your project's accumulated knowledge. It keeps agents from rediscovering the
          same patterns, lessons, and runbooks on every task.
        </p>

        <h2>1. Store and label knowledge</h2>
        <p>
          You ingest project files, specs, runbooks, and lessons into Tuberosa. Each item becomes a{' '}
          <GlossaryTerm termKey="knowledge_item">knowledge item</GlossaryTerm> with{' '}
          <GlossaryTerm termKey="label">labels</GlossaryTerm> (files, symbols, errors, technologies),{' '}
          <GlossaryTerm termKey="reference">references</GlossaryTerm>, a{' '}
          <GlossaryTerm termKey="trust_level">trust level</GlossaryTerm>, and a{' '}
          <GlossaryTerm termKey="freshness">freshness</GlossaryTerm> timestamp. Long docs are split by heading via
          the <GlossaryTerm termKey="atomizer">atomizer</GlossaryTerm> so each idea is independently retrievable.
        </p>

        <h2>2. Classify and search</h2>
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

        <h2>3. Feedback and learn</h2>
        <p>
          The agent records <GlossaryTerm termKey="context_decision">context decisions</GlossaryTerm> on what was
          useful, noisy, missing, or stale. Each decision adjusts future scoring. When the agent finishes, it can
          emit a <GlossaryTerm termKey="reflection_draft">reflection draft</GlossaryTerm> with the lesson it
          learned, optionally backed by structured{' '}
          <GlossaryTerm termKey="learning_signal">learning signals</GlossaryTerm>.
        </p>

        <h2>4. Review and approve</h2>
        <p>
          The <GlossaryTerm termKey="learning_gate">learning gate</GlossaryTerm> evaluates each draft against 11
          quality signals. If every gate passes the draft is auto-approved into{' '}
          <GlossaryTerm termKey="memory">memory</GlossaryTerm>; otherwise it lands here in the workbench for
          human review. The recommendation panel surfaces every gate as a pro, con, or blocker so you can decide
          quickly.
        </p>

        <h2>What you do here</h2>
        <ul class="bullets">
          <li>Review pending <GlossaryTerm termKey="reflection_draft">reflection drafts</GlossaryTerm> and approve, edit, or reject them.</li>
          <li>Audit risky auto-approved memories and roll them back if needed.</li>
          <li>Investigate <GlossaryTerm termKey="knowledge_gap">knowledge gaps</GlossaryTerm> and ingest the missing material.</li>
          <li>Apply <GlossaryTerm termKey="learning_proposal">learning proposals</GlossaryTerm> to keep the knowledge base tidy.</li>
          <li>Triage <GlossaryTerm termKey="error_log">error logs</GlossaryTerm> and turn recurring failures into reflections.</li>
        </ul>

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
