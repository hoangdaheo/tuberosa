import { TOKEN_CHARS } from '../util/text.js';

const SIGNAL_REGEXES: RegExp[] = [
  /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+/g,
  /\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z][A-Za-z0-9]*)+\b/g,
  /\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g,
  /\b(?:update|refactor|fix|add|remove|rename|migrate|verify)\b/gi,
];

export interface AnchorWindow {
  start: number;
  end: number;
  text: string;
}

export function pickAnchorWindow(prompt: string, windowTokens: number = 1500): AnchorWindow {
  const windowChars = windowTokens * TOKEN_CHARS;
  if (prompt.length <= windowChars) {
    return { start: 0, end: prompt.length, text: prompt };
  }
  const step = Math.max(64, Math.floor(windowChars / 8));
  let bestStart = 0;
  let bestScore = -1;
  const scoreSlice = (start: number): number => {
    const slice = prompt.slice(start, start + windowChars);
    let score = 0;
    for (const re of SIGNAL_REGEXES) {
      score += (slice.match(re) ?? []).length;
    }
    return score;
  };
  for (let start = 0; start + windowChars <= prompt.length; start += step) {
    const score = scoreSlice(start);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  // Stepped scan can leave a tail uncovered when `step` does not align with the
  // end. Always score one final window flush to prompt.length so signals
  // clustered at the tail can still win.
  const tailStart = prompt.length - windowChars;
  if (tailStart > bestStart) {
    const tailScore = scoreSlice(tailStart);
    if (tailScore > bestScore) {
      bestStart = tailStart;
    }
  }
  const end = bestStart + windowChars;
  return { start: bestStart, end, text: prompt.slice(bestStart, end) };
}
