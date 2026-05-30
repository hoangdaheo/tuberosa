import yaml from 'js-yaml';
import type { AtomProducer, KnowledgeAtom } from '../types/atoms.js';
import type { AtomFrontmatter } from '../types/export-bundle.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedAtomMarkdown {
  frontmatter: AtomFrontmatter;
  body: string;
}

export function parseAtomMarkdown(
  content: string,
  options: { filename?: string } = {},
): ParsedAtomMarkdown {
  const where = options.filename ? ` in ${options.filename}` : '';
  const m = FRONTMATTER_RE.exec(content);
  if (!m) {
    throw new Error(`Atom markdown missing frontmatter${where}`);
  }
  let frontmatter: AtomFrontmatter;
  try {
    frontmatter = yaml.load(m[1]!) as AtomFrontmatter;
  } catch (error) {
    throw new Error(`Invalid frontmatter${where}: ${(error as Error).message}`);
  }
  if (!frontmatter || typeof frontmatter !== 'object' || !frontmatter.id) {
    throw new Error(`Atom frontmatter missing required 'id'${where}`);
  }
  return { frontmatter, body: m[2] ?? '' };
}

export function serializeAtom(
  atom: KnowledgeAtom,
  options: { revision: number },
): { content: string; filename: string } {
  const frontmatter: AtomFrontmatter = {
    id: atom.id,
    revision: options.revision,
    project: atom.project,
    type: atom.type,
    tier: atom.tier,
    status: atom.status,
    trigger: atom.trigger,
    evidence: atom.evidence,
    verification: atom.verification,
    pitfalls: atom.pitfalls,
    links: atom.links,
    audit: {
      producedBy: atom.audit.producedBy,
      producedAtSessionId: atom.audit.producedAtSessionId,
      createdAt: atom.audit.createdAt,
      updatedAt: atom.audit.updatedAt,
    },
    scope: atom.scope,
    userId: atom.userId,
    priority: atom.priority,
    metadata: atom.metadata && Object.keys(atom.metadata).length > 0 ? atom.metadata : undefined,
  };
  const yamlBlock = yaml.dump(frontmatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  const content = `---\n${yamlBlock}---\n\n${atom.claim}\n`;
  return { content, filename: atomFilename(atom) };
}

const SLUG_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'was', 'and', 'or', 'for', 'with', 'at',
]);

export function atomFilename(atom: KnowledgeAtom): string {
  const slug = atom.claim
    .toLowerCase()
    .split(/[\W_]+/)
    .filter((w) => w.length > 2 && !SLUG_STOP_WORDS.has(w))
    .slice(0, 7)
    .join('-') || 'atom';
  const shortId = atom.id.replace(/-/g, '').slice(0, 4);
  return `${slug}-${shortId}.md`;
}

export function toAtomInputFromParsed(parsed: ParsedAtomMarkdown): KnowledgeAtom {
  const fm = parsed.frontmatter;
  const claim = fm.claim ?? parsed.body.trim();
  return {
    id: fm.id,
    project: fm.project,
    claim,
    type: fm.type,
    evidence: fm.evidence,
    trigger: fm.trigger,
    verification: fm.verification,
    pitfalls: fm.pitfalls,
    links: fm.links,
    tier: fm.tier,
    reuseCount: 0,
    lastReusedAt: undefined,
    status: fm.status,
    audit: {
      producedBy: fm.audit.producedBy as AtomProducer,
      producedAtSessionId: fm.audit.producedAtSessionId,
      createdAt: fm.audit.createdAt,
      updatedAt: fm.audit.updatedAt,
    },
    scope: (fm.scope as KnowledgeAtom['scope'] | undefined) ?? 'project',
    userId: fm.userId,
    priority: fm.priority as KnowledgeAtom['priority'] | undefined,
    metadata: (fm.metadata as Record<string, unknown> | undefined) ?? {},
  };
}
