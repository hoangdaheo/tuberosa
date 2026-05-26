import type { ContextStackItemView, ContextStackView } from '../types.js';
import { Pill } from './Pill.js';

export function ContextStack({ stack }: { stack: ContextStackView }) {
  return (
    <section class="visual-panel" data-testid="context-stack">
      <div class="section-heading">
        <h2>Context stack</h2>
        <p class="muted small">Readable fallback for the graph: essential, supporting, and optional evidence.</p>
      </div>
      <div class="context-stack-grid">
        <StackColumn title="Essential" testid="context-stack-essential" items={stack.essential} />
        <StackColumn title="Supporting" testid="context-stack-supporting" items={stack.supporting} />
        <StackColumn title="Optional" testid="context-stack-optional" items={stack.optional} />
      </div>
    </section>
  );
}

function StackColumn({ title, testid, items }: { title: string; testid: string; items: ContextStackItemView[] }) {
  return (
    <div class="stack-column" data-testid={testid}>
      <h3>{title}</h3>
      {items.length === 0 ? <p class="muted small">No items.</p> : items.map((item) => (
        <article class="context-item" key={item.knowledgeId}>
          <div class="row between">
            <strong>{item.title}</strong>
            <Pill kind={item.evidenceStrength === 'strong' ? 'good' : item.evidenceStrength === 'moderate' ? 'warn' : 'muted'}>{item.evidenceStrength}</Pill>
          </div>
          <p class="small muted">{item.summary}</p>
          {item.why && <p class="small">{item.why}</p>}
        </article>
      ))}
    </div>
  );
}
