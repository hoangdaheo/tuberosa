import yaml from 'js-yaml';
import type { StoredKnowledge } from '../types.js';
import type { KnowledgeFrontmatter } from '../types/export-bundle.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedKnowledgeMarkdown {
  frontmatter: KnowledgeFrontmatter;
  body: string;
}

export function parseKnowledgeMarkdown(
  content: string,
  options: { filename?: string } = {},
): ParsedKnowledgeMarkdown {
  const where = options.filename ? ` in ${options.filename}` : '';
  const m = FRONTMATTER_RE.exec(content);
  if (!m) throw new Error(`Knowledge markdown missing frontmatter${where}`);
  let frontmatter: KnowledgeFrontmatter;
  try {
    frontmatter = yaml.load(m[1]!) as KnowledgeFrontmatter;
  } catch (error) {
    throw new Error(`Invalid frontmatter${where}: ${(error as Error).message}`);
  }
  if (!frontmatter || typeof frontmatter !== 'object' || !frontmatter.id) {
    throw new Error(`Knowledge frontmatter missing 'id'${where}`);
  }
  return { frontmatter, body: m[2] ?? '' };
}

export function serializeKnowledge(
  k: StoredKnowledge,
): { content: string; filename: string } {
  const fm: KnowledgeFrontmatter = {
    id: k.id,
    project: k.project,
    itemType: k.itemType as KnowledgeFrontmatter['itemType'],
    title: k.title,
    labels: k.labels.map((l) => ({ type: l.type, value: l.value, weight: l.weight })),
    references: k.references.map((r) => ({
      type: r.type,
      uri: r.uri,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
    })),
    trustLevel: k.trustLevel ?? 50,
    audit: { createdAt: k.createdAt, updatedAt: k.updatedAt ?? k.createdAt },
  };
  const yamlBlock = yaml.dump(fm, { lineWidth: 120, noRefs: true, sortKeys: false });
  const content = `---\n${yamlBlock}---\n\n${k.content}\n`;
  return { content, filename: knowledgeFilename(k) };
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'was', 'and', 'or', 'for', 'with', 'at',
]);

export function knowledgeFilename(k: StoredKnowledge): string {
  const slug = (k.title || k.id)
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .split(/[\W_]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 7)
    .join('-') || 'knowledge';
  const shortId = k.id.replace(/-/g, '').slice(0, 4);
  return `${slug}-${shortId}.md`;
}
