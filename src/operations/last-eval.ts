import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_PATH = resolve(process.cwd(), '.tuberosa/last-eval.json');

export interface LastEvalMetrics {
  hitRate?: number;
  meanReciprocalRank?: number;
  selectedCoverageRate?: number;
  staleRejectionRate?: number;
  exactFileMatchRate?: number;
  exactSymbolMatchRate?: number;
  exactErrorMatchRate?: number;
}

export interface LastEvalRecord {
  status: 'pass' | 'fail';
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  fixtureName?: string;
  project?: string;
  metrics: LastEvalMetrics;
}

export interface WriteLastEvalOptions {
  path?: string;
}

export function writeLastEval(record: LastEvalRecord, options: WriteLastEvalOptions = {}): string {
  const path = options.path ?? DEFAULT_PATH;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export interface ReadLastEvalOptions {
  path?: string;
}

export function readLastEval(options: ReadLastEvalOptions = {}): LastEvalRecord | null {
  const path = options.path ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as LastEvalRecord;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || (parsed.status !== 'pass' && parsed.status !== 'fail')
      || typeof parsed.generatedAt !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function defaultLastEvalPath(): string {
  return DEFAULT_PATH;
}
