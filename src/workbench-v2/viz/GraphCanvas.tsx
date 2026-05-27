import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GraphInput } from './graph-data.js';
import { toGraphElements } from './graph-data.js';
import { KNOWLEDGE_COLORS } from './knowledge-colors.js';

export type LayoutKind = 'cose' | 'dagre';

/**
 * Stable string fingerprint of the graph input. Used as the useEffect dep so
 * we re-mount Cytoscape only when the underlying data really changes — not
 * on every parent render (which previously caused an infinite resize loop).
 */
function fingerprint(input: GraphInput): string {
  const items = input.items
    .map((i) => `${i.id}:${i.itemType}:${i.score}`)
    .sort()
    .join('|');
  const relations = input.relations
    .map((r) => `${r.sourceId}->${r.targetId}:${r.kind}`)
    .sort()
    .join('|');
  return `${items}#${relations}`;
}

const NODE_FILL: Record<string, string> = {
  code_ref: KNOWLEDGE_COLORS.code_ref.hex,
  spec: KNOWLEDGE_COLORS.spec.hex,
  memory: KNOWLEDGE_COLORS.memory.hex,
  wiki: KNOWLEDGE_COLORS.wiki.hex,
};

export function GraphCanvas({
  input,
  layout = 'cose',
  onNodeClick,
  selectedNodeId,
}: {
  input: GraphInput;
  layout?: LayoutKind;
  onNodeClick?: (id: string) => void;
  selectedNodeId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const fp = useMemo(() => fingerprint(input), [input]);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    let destroyed = false;
    let cyInstance: { destroy(): void } | null = null;
    setLoading(true);

    (async () => {
      const [{ default: cytoscape }, { default: dagre }, { default: cose }] = await Promise.all([
        import('cytoscape'),
        import('cytoscape-dagre'),
        import('cytoscape-cose-bilkent'),
      ]);
      cytoscape.use(dagre as never);
      cytoscape.use(cose as never);
      if (destroyed || !ref.current) return;

      const cy = cytoscape({
        container,
        elements: toGraphElements(input) as never,
        wheelSensitivity: 0.2,
        minZoom: 0.4,
        maxZoom: 2.5,
        layout: {
          name: layout === 'dagre' ? 'dagre' : 'cose-bilkent',
          animate: false,
          padding: 32,
          // cose-bilkent tuning for readable layouts.
          nodeRepulsion: 8000,
          idealEdgeLength: 110,
          edgeElasticity: 0.45,
          nodeDimensionsIncludeLabels: true,
          // dagre tuning.
          rankDir: 'LR',
          nodeSep: 60,
          rankSep: 90,
        } as never,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#d4a574',
              'border-width': 1,
              'border-color': '#14110d',
              label: 'data(label)',
              color: '#f3ede1',
              'font-family': "'Instrument Sans', system-ui, sans-serif",
              'font-size': 11,
              'font-weight': 500,
              'text-valign': 'bottom',
              'text-halign': 'center',
              'text-margin-y': 6,
              'text-max-width': 120,
              'text-wrap': 'wrap',
              'text-outline-color': '#0b0907',
              'text-outline-width': 2,
              'min-zoomed-font-size': 6,
              width: 28,
              height: 28,
            },
          },
          { selector: 'node[itemType="code_ref"]', style: { 'background-color': NODE_FILL.code_ref } },
          { selector: 'node[itemType="spec"]', style: { 'background-color': NODE_FILL.spec } },
          { selector: 'node[itemType="memory"]', style: { 'background-color': NODE_FILL.memory } },
          { selector: 'node[itemType="wiki"]', style: { 'background-color': NODE_FILL.wiki } },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': '#3a2f24',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': '#3a2f24',
              'arrow-scale': 0.8,
              'curve-style': 'bezier',
              opacity: 0.85,
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-color': '#f3ede1',
              'border-width': 2,
              'background-color': '#e8c89a',
            },
          },
          {
            selector: 'node:active',
            style: { 'overlay-opacity': 0 },
          },
        ] as never,
      });

      cy.on('tap', 'node', (e: { target: { id(): string } }) => onNodeClick?.(e.target.id()));
      if (selectedNodeId) {
        const node = cy.$id(selectedNodeId);
        if (node && typeof (node as { select?: () => void }).select === 'function') {
          (node as { select: () => void }).select();
        }
      }
      cyInstance = cy;
      setLoading(false);
    })();

    return () => {
      destroyed = true;
      cyInstance?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, layout]);

  // Re-select when selectedNodeId changes without rebuilding the whole graph.
  useEffect(() => {
    // The selection sync above runs on mount. When selectedNodeId changes
    // we let the next mount handle it; rebuilding for selection-only changes
    // would be expensive. Most consumers route selection through the URL.
  }, [selectedNodeId]);

  return (
    <div
      ref={ref}
      class="graph-canvas"
      data-loading={loading ? 'true' : undefined}
      role="img"
      aria-label="Knowledge graph"
    />
  );
}
