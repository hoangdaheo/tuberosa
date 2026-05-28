import type { BundleEdge } from '../types/export-bundle.js';

/**
 * Sort by (from, to, kind) so re-exporting the same store yields a byte-stable
 * file. The importer treats edge order as insignificant, so this is purely a
 * diff-stability concern.
 */
export function serializeEdges(edges: BundleEdge[]): string {
  const sorted = [...edges].sort(
    (a, b) =>
      a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind),
  );
  return sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length > 0 ? '\n' : '');
}

export function parseEdgesJsonl(content: string): BundleEdge[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BundleEdge);
}
