export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeLabel(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-|-$/g, '');
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function sameSignal(left: string, right: string): boolean {
  return normalizeLabel(left) === normalizeLabel(right);
}

export function sameSignals(left: string[] | undefined, right: string[] | undefined): boolean {
  return (left ?? []).join('\0') === (right ?? []).join('\0');
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function splitIntoChunks(content: string, maxTokens = 480): string[] {
  const paragraphs = content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [content]) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(next) <= maxTokens) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (estimateTokens(paragraph) <= maxTokens) {
      current = paragraph;
      continue;
    }

    const sentences = paragraph.match(/[^.!?]+[.!?]?/g) ?? [paragraph];
    for (const sentence of sentences) {
      const maybe = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (estimateTokens(maybe) > maxTokens && current) {
        chunks.push(current);
        current = sentence.trim();
      } else {
        current = maybe;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
