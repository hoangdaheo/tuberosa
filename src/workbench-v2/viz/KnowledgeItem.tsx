import { KNOWLEDGE_COLORS, labelFor, type KnowledgeItemType } from './knowledge-colors.js';

export function inferItemType(id: string): KnowledgeItemType {
  if (id.startsWith('cr-')) return 'code_ref';
  if (id.startsWith('spec-')) return 'spec';
  if (id.startsWith('mem-')) return 'memory';
  return 'wiki';
}

export function KnowledgeItem({
  id,
  title,
  itemType,
  sourceUri,
  tokens,
}: {
  id: string;
  title: string;
  itemType?: string;
  sourceUri?: string;
  tokens?: number;
}) {
  const type = (itemType as KnowledgeItemType | undefined) ?? inferItemType(id);
  const hex = KNOWLEDGE_COLORS[type as KnowledgeItemType]?.hex ?? KNOWLEDGE_COLORS.wiki.hex;
  return (
    <div
      data-id={id}
      style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:baseline;font-size:var(--fs-small);color:var(--paper-1)"
    >
      <span
        style={`flex:none;font-size:var(--fs-overline);letter-spacing:0.06em;color:var(--paper-0);padding:1px 6px;border-radius:4px;border:1px solid ${hex};background:${hex}22`}
      >
        {labelFor(type)}
      </span>
      <span style="min-width:0">
        <span style="color:var(--paper-0)">{title}</span>
        {sourceUri && (
          <span class="code" style="display:block;color:var(--paper-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {sourceUri}
          </span>
        )}
        {typeof tokens === 'number' && (
          <span style="color:var(--paper-3);font-size:var(--fs-overline);margin-left:0"> · {tokens} tok</span>
        )}
      </span>
    </div>
  );
}
