import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import type { SeedKnowledgeItem } from '../data/fixtures.js';
import { GraphCanvas } from '../viz/GraphCanvas.js';
import type { GraphInput } from '../viz/graph-data.js';
import { route, setRoute } from '../state/store.js';

type ItemKind = 'wiki' | 'spec' | 'code_ref' | 'memory';
const ALL: ItemKind[] = ['wiki', 'spec', 'code_ref', 'memory'];

function labelStrings(item: SeedKnowledgeItem): string[] {
  return item.labels.map((l) => l.value);
}

export default function Ch05_KnowledgeGraph() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 5) : undefined), []);
  const [layout, setLayout] = useState<'cose' | 'dagre'>('cose');
  const [filters, setFilters] = useState<Set<ItemKind>>(new Set(ALL));

  const items = acmeBilling.items;
  const visible = items.filter((i) => filters.has(i.itemType as ItemKind));
  const visibleIds = new Set(visible.map((i) => i.id));

  const input: GraphInput = useMemo(
    () => ({
      items: visible.map((i) => ({
        id: i.id,
        title: i.title,
        itemType: i.itemType,
        score: 1,
        labels: labelStrings(i),
      })),
      relations: acmeBilling.relations
        .filter((r) => visibleIds.has(r.fromId) && visibleIds.has(r.toId))
        .map((r) => ({ sourceId: r.fromId, targetId: r.toId, kind: r.kind })),
    }),
    [visible],
  );

  const selectedId = route.value.graphNodeId;
  const selected = selectedId ? items.find((i) => i.id === selectedId) : undefined;

  return (
    <section id="ch5" class="chapter" ref={ref}>
      <h2>The knowledge graph</h2>
      <p class="lead">Items are nodes. Relations are edges. Click around.</p>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        {ALL.map((k) => (
          <button
            key={k}
            class={`pill ${filters.has(k) ? '' : 'ghost'}`}
            onClick={() => {
              const next = new Set(filters);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              setFilters(next);
            }}
          >
            {k}
          </button>
        ))}
        <button class="ghost" onClick={() => setLayout(layout === 'cose' ? 'dagre' : 'cose')}>
          layout: {layout}
        </button>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:16px">
        <GraphCanvas
          input={input}
          layout={layout}
          selectedNodeId={selectedId}
          onNodeClick={(id) => setRoute({ ...route.value, graphNodeId: id })}
        />
        <aside class="card">
          {selected ? (
            <>
              <strong>{selected.title}</strong>
              <div style="color:var(--fg-muted);font-size:12px;margin-top:4px">
                <span class="code">{selected.sourceUri}</span>
              </div>
              <div style="margin-top:8px">
                {labelStrings(selected).map((l) => (
                  <span key={l} class="pill" style="margin-right:4px">
                    {l}
                  </span>
                ))}
              </div>
              <p style="margin-top:8px;color:var(--fg-muted);font-size:13px">
                {selected.content.slice(0, 240)}…
              </p>
            </>
          ) : (
            <span style="color:var(--fg-muted)">Click a node to inspect it.</span>
          )}
        </aside>
      </div>
    </section>
  );
}
