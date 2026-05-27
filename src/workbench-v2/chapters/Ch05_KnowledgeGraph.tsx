import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import type { SeedKnowledgeItem } from '../data/fixtures.js';
import { GraphCanvas } from '../viz/GraphCanvas.js';
import type { GraphInput } from '../viz/graph-data.js';
import { route, setRoute } from '../state/store.js';
import { GraphLegend } from '../viz/GraphLegend.js';

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
    <section id="ch5" class="chapter" data-numeral="05" ref={ref}>
      <span class="overline">The knowledge graph</span>
      <h2 style="margin-top:var(--space-4)">Items are nodes. Relations are edges.</h2>
      <p class="lead">Filter by item type, toggle layout, click any node to inspect it.</p>
      <div
        style="display:flex;gap:8px;margin-top:var(--space-3);flex-wrap:wrap;align-items:center"
      >
        {ALL.map((k) => (
          <button
            key={k}
            class={filters.has(k) ? 'pill' : 'pill'}
            data-tone={filters.has(k) ? '' : 'neutral'}
            style={`border:0;cursor:pointer;opacity:${filters.has(k) ? 1 : 0.5}`}
            onClick={() => {
              const next = new Set(filters);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              setFilters(next);
            }}
          >
            {k.replace('_', ' ')}
          </button>
        ))}
        <span style="flex:1" />
        <button class="ghost" onClick={() => setLayout(layout === 'cose' ? 'dagre' : 'cose')}>
          layout · {layout}
        </button>
      </div>
      <div
        style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--space-4);margin-top:var(--space-4)"
      >
        <div style="min-width:0">
          <GraphCanvas
            input={input}
            layout={layout}
            selectedNodeId={selectedId}
            onNodeClick={(id) => setRoute({ ...route.value, graphNodeId: id })}
          />
          <GraphLegend />
        </div>
        <aside class="card" style="min-width:0">
          {selected ? (
            <>
              <strong
                style="font-family:var(--font-display);font-weight:500;font-size:18px;display:block"
              >
                {selected.title}
              </strong>
              <div style="color:var(--paper-3);font-size:var(--fs-overline);margin-top:6px;font-family:var(--font-mono);letter-spacing:0.06em">
                <span class="code">{selected.sourceUri}</span>
              </div>
              <div class="row-chips" style="margin-top:var(--space-3)">
                {labelStrings(selected).slice(0, 6).map((l) => (
                  <span key={l} class="pill" data-tone="neutral">
                    {l}
                  </span>
                ))}
              </div>
              <p
                style="margin-top:var(--space-3);color:var(--paper-2);font-size:var(--fs-small);line-height:1.55"
              >
                {selected.content.slice(0, 240)}…
              </p>
            </>
          ) : (
            <span style="color:var(--paper-3);font-style:italic">
              Click a node to inspect it.
            </span>
          )}
        </aside>
      </div>
    </section>
  );
}
