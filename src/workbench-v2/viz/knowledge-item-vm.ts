import type { KnowledgeItemType } from './knowledge-colors.js';

export function inferItemType(id: string): KnowledgeItemType {
  if (id.startsWith('cr-')) return 'code_ref';
  if (id.startsWith('spec-')) return 'spec';
  if (id.startsWith('mem-')) return 'memory';
  return 'wiki';
}
