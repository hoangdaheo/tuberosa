import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { Term } from '../viz/Term.js';

const STAGES = ['classify', 'search', 'rank', 'fit', 'assemble'];

export default function Ch03_Anatomy() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 3) : undefined), []);
  return (
    <section id="ch3" class="chapter" data-numeral="03" ref={ref}>
      <span class="overline">A session, end to end</span>
      <h2 style="margin-top:var(--space-4)">The big picture</h2>
      <p class="lead">One prompt in. Three groups of context out. About eighty milliseconds.</p>
      <div class="card" style="margin-top:var(--space-4);display:flex;gap:var(--space-3);align-items:baseline">
        <span class="overline" style="flex:none">Prompt</span>
        <span style="font-family:var(--font-display);font-style:italic;font-size:18px;color:var(--paper-0)">
          "Where does paywall logic live?"
        </span>
      </div>
      <div
        class="fade-in"
        style="margin-top:var(--space-5);display:flex;align-items:center;gap:10px;flex-wrap:wrap"
      >
        <span class="pill" data-tone="neutral">prompt</span>
        <span style="color:var(--paper-3)">→</span>
        {STAGES.map((s) => (
          <span key={s} class="pill">{s}</span>
        ))}
        <span style="color:var(--paper-3)">→</span>
        <span class="pill" data-tone="good">essential · supporting · optional</span>
      </div>
      <p style="margin-top:var(--space-5);color:var(--paper-2);max-width:60ch">
        Ten short stages turn a question into a ranked, budgeted context pack. We{' '}
        <Term k="fuse">fuse</Term> several search sources, <Term k="rerank">rerank</Term>{' '}
        the top slice, decide context <Term k="fit">fit</Term>, and assemble the pack. The next
        chapter lets you click into each stage.
      </p>
    </section>
  );
}
