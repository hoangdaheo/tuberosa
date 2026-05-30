/** Cosine similarity of two numeric (embedding) vectors. Returns 0 for empty or zero-norm inputs. */
export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  if (len === 0) return 0;
  let dot = 0;
  let normL = 0;
  let normR = 0;
  for (let i = 0; i < len; i += 1) {
    const l = left[i]!;
    const r = right[i]!;
    dot += l * r;
    normL += l * l;
    normR += r * r;
  }
  if (normL === 0 || normR === 0) return 0;
  return dot / (Math.sqrt(normL) * Math.sqrt(normR));
}
