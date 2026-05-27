import { ITEM_TYPES, KNOWLEDGE_COLORS, type KnowledgeItemType } from './knowledge-colors.js';

export function GraphLegend({ types }: { types?: string[] }) {
  const shown: KnowledgeItemType[] = types
    ? ITEM_TYPES.filter((t) => types.includes(t))
    : ITEM_TYPES;
  if (shown.length === 0) return null;
  return (
    <ul
      class="graph-legend"
      aria-label="Node color key"
      style="display:flex;flex-wrap:wrap;gap:12px;margin:10px 0 0;padding:0;list-style:none"
    >
      {shown.map((t) => (
        <li key={t} style="display:flex;align-items:center;gap:6px;font-size:var(--fs-overline);color:var(--paper-3);letter-spacing:0.06em">
          <span
            aria-hidden="true"
            style={`width:10px;height:10px;border-radius:50%;background:${KNOWLEDGE_COLORS[t].hex};border:1px solid var(--ink-0);flex:none`}
          />
          {KNOWLEDGE_COLORS[t].label}
        </li>
      ))}
    </ul>
  );
}
