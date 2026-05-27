export type KnowledgeItemType = 'code_ref' | 'spec' | 'memory' | 'wiki';

export const ITEM_TYPES: KnowledgeItemType[] = ['code_ref', 'spec', 'memory', 'wiki'];

export const KNOWLEDGE_COLORS: Record<KnowledgeItemType, { hex: string; label: string }> = {
  code_ref: { hex: '#d4a574', label: 'code' },
  spec: { hex: '#c46a4d', label: 'spec' },
  memory: { hex: '#8fae7e', label: 'memory' },
  wiki: { hex: '#948b7c', label: 'wiki' },
};

function asKnownType(itemType: string): KnowledgeItemType {
  return (ITEM_TYPES as string[]).includes(itemType) ? (itemType as KnowledgeItemType) : 'wiki';
}

export function colorFor(itemType: string): string {
  return KNOWLEDGE_COLORS[asKnownType(itemType)].hex;
}

export function labelFor(itemType: string): string {
  return KNOWLEDGE_COLORS[asKnownType(itemType)].label;
}
