import { useEffect, useRef } from 'preact/hooks';
import type { GraphInput } from './graph-data.js';
import { toGraphElements } from './graph-data.js';

export type LayoutKind = 'cose' | 'dagre';

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

  useEffect(() => {
    if (!ref.current) return;
    let destroyed = false;
    let cyInstance: { destroy(): void } | null = null;
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
        container: ref.current,
        elements: toGraphElements(input) as never,
        layout: { name: layout === 'dagre' ? 'dagre' : 'cose-bilkent', animate: true } as never,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#6aa6ff',
              label: 'data(label)',
              color: '#e7e9ee',
              'font-size': 10,
            },
          },
          { selector: 'node[itemType="spec"]', style: { 'background-color': '#f6b86b' } },
          { selector: 'node[itemType="memory"]', style: { 'background-color': '#6ddc8e' } },
          { selector: 'node[itemType="wiki"]', style: { 'background-color': '#9aa3b2' } },
          {
            selector: 'edge',
            style: {
              'line-color': '#232838',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': '#232838',
              'curve-style': 'bezier',
            },
          },
          { selector: ':selected', style: { 'border-color': '#fff', 'border-width': 2 } },
        ] as never,
      });
      cy.on('tap', 'node', (e: { target: { id(): string } }) => onNodeClick?.(e.target.id()));
      if (selectedNodeId) cy.$id(selectedNodeId).select();
      cyInstance = cy;
    })();
    return () => {
      destroyed = true;
      cyInstance?.destroy();
    };
  }, [input, layout]);

  return (
    <div
      ref={ref}
      style="width:100%;height:480px;border:1px solid var(--line);border-radius:12px;background:var(--bg-elev)"
    />
  );
}
