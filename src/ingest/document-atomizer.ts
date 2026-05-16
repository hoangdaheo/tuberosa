import { normalizeLabel } from '../util/text.js';

const MIN_ATOM_BODY_CHARS = 12;

export interface DocumentAtom {
  title: string;
  summary: string;
  content: string;
  sectionPath: string[];
  sectionSlug: string;
  headingLevel?: number;
  lineStart: number;
  lineEnd: number;
}

export interface DocumentAtomizerInput {
  path: string;
  content: string;
}

export interface DocumentAtomizer {
  supports(path: string): boolean;
  atomize(input: DocumentAtomizerInput): DocumentAtom[];
}

interface MarkdownHeading {
  level: number;
  title: string;
  lineIndex: number;
  sectionPath: string[];
}

export class MarkdownAtomizer implements DocumentAtomizer {
  supports(path: string): boolean {
    const lower = path.toLowerCase();
    return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.includes('/docs/') || lower.includes('/wiki/');
  }

  atomize(input: DocumentAtomizerInput): DocumentAtom[] {
    const lines = input.content.split(/\r?\n/);
    const headings = headingsWithPaths(parseHeadings(lines));
    const atoms: DocumentAtom[] = [];

    if (headings.length === 0) {
      return [wholeDocumentAtom(input.path, input.content, lines.length)];
    }

    const firstHeading = headings[0];
    if (firstHeading.lineIndex > 0) {
      const introContent = lines.slice(0, firstHeading.lineIndex).join('\n').trim();
      if (hasMeaningfulBody(introContent)) {
        atoms.push({
          title: `${displayName(input.path)} introduction`,
          summary: summarizeAtom(introContent, `${displayName(input.path)} introduction`),
          content: introContent,
          sectionPath: ['Introduction'],
          sectionSlug: 'introduction',
          lineStart: 1,
          lineEnd: firstHeading.lineIndex,
        });
      }
    }

    headings.forEach((heading, index) => {
      const nextHeading = headings[index + 1];
      const start = heading.lineIndex;
      const end = nextHeading?.lineIndex ?? lines.length;
      const content = lines.slice(start, end).join('\n').trim();

      if (!hasMeaningfulBody(content)) {
        return;
      }

      atoms.push({
        title: heading.sectionPath.join(' > '),
        summary: summarizeAtom(content, heading.title),
        content,
        sectionPath: heading.sectionPath,
        sectionSlug: slugForPath(heading.sectionPath),
        headingLevel: heading.level,
        lineStart: start + 1,
        lineEnd: end,
      });
    });

    return ensureUniqueSlugs(atoms.length > 0 ? atoms : [wholeDocumentAtom(input.path, input.content, lines.length)]);
  }
}

function parseHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  let fenceMarker = '';

  lines.forEach((line, index) => {
    const fence = /^(?<marker>`{3,}|~{3,})/.exec(line.trim());
    if (fence?.groups?.marker) {
      const marker = fence.groups.marker[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      return;
    }

    if (inFence) {
      return;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      return;
    }

    headings.push({
      level: heading[1].length,
      title: cleanHeading(heading[2]),
      lineIndex: index,
      sectionPath: [],
    });
  });

  return headings;
}

function headingsWithPaths(headings: MarkdownHeading[]): MarkdownHeading[] {
  const stack: MarkdownHeading[] = [];

  return headings.map((heading) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    const sectionPath = [...stack.map((ancestor) => ancestor.title), heading.title];
    const withPath = { ...heading, sectionPath };
    stack.push(withPath);
    return withPath;
  });
}

function wholeDocumentAtom(path: string, content: string, lineCount: number): DocumentAtom {
  const title = displayName(path);
  return {
    title,
    summary: summarizeAtom(content, title),
    content: content.trim(),
    sectionPath: [title],
    sectionSlug: 'document',
    lineStart: 1,
    lineEnd: Math.max(1, lineCount),
  };
}

function hasMeaningfulBody(content: string): boolean {
  const body = content
    .replace(/^#{1,6}\s+.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .trim();

  return body.length >= MIN_ATOM_BODY_CHARS;
}

function summarizeAtom(content: string, fallback: string): string {
  const withoutHeadings = content.replace(/^#{1,6}\s+.+$/gm, '').trim();
  const paragraph = withoutHeadings
    .split(/\n{2,}/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .find(Boolean);

  return (paragraph ?? fallback).slice(0, 360);
}

function displayName(path: string): string {
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return name.replace(/\.[^.]+$/, '') || name;
}

function cleanHeading(value: string): string {
  return value.replace(/\s+#*$/, '').trim();
}

function slugForPath(sectionPath: string[]): string {
  return normalizeLabel(sectionPath.join('-')) || 'section';
}

function ensureUniqueSlugs(atoms: DocumentAtom[]): DocumentAtom[] {
  const counts = new Map<string, number>();

  return atoms.map((atom) => {
    const count = counts.get(atom.sectionSlug) ?? 0;
    counts.set(atom.sectionSlug, count + 1);

    if (count === 0) {
      return atom;
    }

    return { ...atom, sectionSlug: `${atom.sectionSlug}-${count + 1}` };
  });
}
