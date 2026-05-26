import { useMemo, useState } from 'preact/hooks';
import type { EvidenceGraphNode, EvidenceGraphView } from '../types.js';
import { DetailPanel } from './DetailPanel.js';

export function EvidenceGraph({ graph }: { graph: EvidenceGraphView }) {
  const [selected, setSelected] = useState<EvidenceGraphNode | null>(null);
  const layout = useMemo(() => layoutGraph(graph.nodes), [graph.nodes]);
  return (
    <section class="visual-panel evidence-graph-panel" data-testid="evidence-graph">
      <div class="section-heading">
        <h2>Evidence graph</h2>
        <p class="muted small">Prompt, context pack, knowledge, files, and symbols that shaped this result.</p>
      </div>
      <div class="graph-wrap">
        <svg viewBox="0 0 720 360" role="img" aria-label="Evidence graph">
          {graph.edges.map((edge) => {
            const from = layout.get(edge.from);
            const to = layout.get(edge.to);
            if (!from || !to) return null;
            return <line key={edge.id} class={`graph-edge ${edge.tone}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {graph.nodes.map((node) => {
            const point = layout.get(node.id);
            if (!point) return null;
            return (
              <g key={node.id} class={`graph-node ${node.tone}`} onClick={() => setSelected(node)} tabIndex={0}>
                <circle cx={point.x} cy={point.y} r={node.kind === 'task' || node.kind === 'pack' ? 28 : 22} />
                <text x={point.x} y={point.y + 42}>{shortLabel(node.label)}</text>
              </g>
            );
          })}
        </svg>
        <ul class="graph-list" aria-label="Evidence graph fallback list">
          {graph.nodes.map((node) => <li key={node.id}><strong>{node.label}</strong><span>{node.kind}</span></li>)}
        </ul>
      </div>
      <DetailPanel title={selected?.label ?? 'Evidence detail'} open={Boolean(selected)} onClose={() => setSelected(null)}>
        {selected && <p>{selected.detail ?? selected.kind}</p>}
      </DetailPanel>
    </section>
  );
}

function layoutGraph(nodes: EvidenceGraphNode[]): Map<string, { x: number; y: number }> {
  const points = new Map<string, { x: number; y: number }>();
  const centerX = 360;
  const centerY = 180;
  const outer = nodes.filter((node) => node.kind !== 'task' && node.kind !== 'pack');
  points.set('task', { x: 250, y: centerY });
  const pack = nodes.find((node) => node.kind === 'pack');
  if (pack) points.set(pack.id, { x: 470, y: centerY });
  outer.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(outer.length, 1) - Math.PI / 2;
    points.set(node.id, { x: centerX + Math.cos(angle) * 270, y: centerY + Math.sin(angle) * 125 });
  });
  return points;
}

function shortLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 19)}...` : label;
}
