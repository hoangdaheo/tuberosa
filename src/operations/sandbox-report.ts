import { readFileSync, statSync } from 'node:fs';

export interface SandboxHeadline {
  hitRate?: number;
  mrr?: number;
  noiseRate?: number;
  staleSuppression?: number;
  duplicateSuppression?: number;
  adversarialBlock?: number;
  latencyP50?: number;
  latencyP95?: number;
  latencyMax?: number;
  generatedAt?: string;
}

export interface ParsedSandboxReport {
  headline: SandboxHeadline;
  status: 'pass' | 'fail' | 'unknown';
  generatedAt?: string;
  path: string;
}

/**
 * Parse `eval/sandbox/report.md`'s headline metrics + status footer.
 * Returns null when the file is missing or empty. Defensive parser — unknown rows are skipped silently
 * so a partial report still produces a usable headline.
 */
export function parseSandboxReport(text: string, path = 'eval/sandbox/report.md'): ParsedSandboxReport | null {
  if (!text.trim()) {
    return null;
  }

  const headline: SandboxHeadline = {};
  const rowRegex = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(text)) !== null) {
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (key === 'hit rate') headline.hitRate = parsePercent(value);
    else if (key === 'mrr') headline.mrr = parseNumber(value);
    else if (key === 'noise rate') headline.noiseRate = parsePercent(value);
    else if (key === 'stale suppression') headline.staleSuppression = parsePercent(value);
    else if (key === 'duplicate suppression') headline.duplicateSuppression = parsePercent(value);
    else if (key === 'adversarial block rate') headline.adversarialBlock = parsePercent(value);
    else if (key === 'latency p50 / p95 / max (ms)') {
      const parts = value.split('/').map((part) => Number.parseFloat(part.trim()));
      if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
        [headline.latencyP50, headline.latencyP95, headline.latencyMax] = parts;
      }
    }
  }

  const statusMatch = /\*\*Status:\*\*\s*(.+?)$/im.exec(text);
  const status: ParsedSandboxReport['status'] = !statusMatch
    ? 'unknown'
    : /all thresholds passed/i.test(statusMatch[1]!) ? 'pass' : 'fail';

  return { headline, status, path };
}

export function readSandboxReport(path: string): ParsedSandboxReport | null {
  try {
    statSync(path);
  } catch {
    return null;
  }
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = parseSandboxReport(text, path);
    if (!parsed) return null;
    try {
      const mtimeMs = statSync(path).mtimeMs;
      parsed.generatedAt = new Date(mtimeMs).toISOString();
    } catch {
      // ignore — we already have the report content
    }
    return parsed;
  } catch {
    return null;
  }
}

function parsePercent(raw: string): number | undefined {
  const match = /([\d.]+)\s*%/.exec(raw);
  return match ? Number.parseFloat(match[1]!) / 100 : undefined;
}

function parseNumber(raw: string): number | undefined {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}
