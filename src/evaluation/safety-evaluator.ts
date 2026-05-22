import { readFile } from 'node:fs/promises';
import {
  KnowledgeSafetyService,
  SECRET_PATTERN_NAMES,
  type SecretScanResult,
} from '../security/knowledge-safety.js';

/**
 * Phase 9 — knowledge-safety FP/FN evaluator.
 *
 * Inputs: the static fixture at `eval/safety-fixtures.json`, which holds
 *  - `true_positive` cases that MUST trigger at least one secret pattern, and
 *  - `true_negative` cases that MUST NOT trigger any secret pattern.
 *
 * Outputs: overall precision / recall / F1 plus per-pattern precision / recall
 * so a future tightening can prove it raised precision without losing recall.
 */

export type SafetyCaseKind = 'true_positive' | 'true_negative';

export interface SafetyFixtureCase {
  id: string;
  kind: SafetyCaseKind;
  category: string;
  /**
   * Name of the SECRET_PATTERN that should fire on a true_positive case. `null`
   * for true_negative cases. Used to compute per-pattern recall.
   */
  expectedPattern: string | null;
  text: string;
}

export interface SafetyFixture {
  name: string;
  description?: string;
  cases: SafetyFixtureCase[];
}

export interface SafetyCaseResult {
  id: string;
  kind: SafetyCaseKind;
  category: string;
  expectedPattern: string | null;
  text: string;
  redacted: boolean;
  firedPatterns: string[];
  redactionCount: number;
  passed: boolean;
}

export interface SafetyPatternMetrics {
  name: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface SafetyOverallMetrics {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface SafetyReport {
  fixtureName: string;
  evaluatedAt: string;
  totalCases: number;
  overall: SafetyOverallMetrics;
  perPattern: SafetyPatternMetrics[];
  cases: SafetyCaseResult[];
}

export async function loadSafetyFixture(filePath: string): Promise<SafetyFixture> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return parseSafetyFixture(parsed, filePath);
}

export function parseSafetyFixture(value: unknown, source = 'safety fixture'): SafetyFixture {
  if (!value || typeof value !== 'object') {
    throw new Error(`${source}: expected an object.`);
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'safety-fixture';
  const description = typeof record.description === 'string' ? record.description : undefined;
  const rawCases = record.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error(`${source}: cases array is required and non-empty.`);
  }
  const cases = rawCases.map((entry, index) => parseSafetyCase(entry, `${source}.cases[${index}]`));
  ensureUniqueIds(cases.map((entry) => entry.id), `${source}.cases[].id`);
  return { name, description, cases };
}

function parseSafetyCase(value: unknown, source: string): SafetyFixtureCase {
  if (!value || typeof value !== 'object') {
    throw new Error(`${source}: expected an object.`);
  }
  const record = value as Record<string, unknown>;
  const id = expectString(record.id, `${source}.id`);
  const kind = expectString(record.kind, `${source}.kind`);
  if (kind !== 'true_positive' && kind !== 'true_negative') {
    throw new Error(`${source}.kind must be 'true_positive' or 'true_negative' (was ${kind}).`);
  }
  const category = expectString(record.category, `${source}.category`);
  const text = expectString(record.text, `${source}.text`);
  let expectedPattern: string | null = null;
  if (kind === 'true_positive') {
    expectedPattern = expectString(record.expectedPattern, `${source}.expectedPattern`);
    if (!SECRET_PATTERN_NAMES.includes(expectedPattern)) {
      throw new Error(
        `${source}.expectedPattern must be one of [${SECRET_PATTERN_NAMES.join(', ')}] (was ${expectedPattern}).`,
      );
    }
  } else if (record.expectedPattern !== null && record.expectedPattern !== undefined) {
    throw new Error(`${source}.expectedPattern must be null for true_negative cases.`);
  }
  return { id, kind, category, expectedPattern, text };
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function ensureUniqueIds(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`${label}: duplicate id ${id}.`);
    }
    seen.add(id);
  }
}

export interface SafetyEvalOptions {
  safety?: KnowledgeSafetyService;
}

export class SafetyEvaluator {
  private readonly safety: KnowledgeSafetyService;

  constructor(options: SafetyEvalOptions = {}) {
    this.safety = options.safety ?? new KnowledgeSafetyService();
  }

  run(fixture: SafetyFixture): SafetyReport {
    const cases: SafetyCaseResult[] = fixture.cases.map((entry) => this.evaluateCase(entry));
    const overall = computeOverallMetrics(cases);
    const perPattern = computePerPatternMetrics(cases);
    return {
      fixtureName: fixture.name,
      evaluatedAt: new Date().toISOString(),
      totalCases: cases.length,
      overall,
      perPattern,
      cases,
    };
  }

  private evaluateCase(entry: SafetyFixtureCase): SafetyCaseResult {
    const scan: SecretScanResult = this.safety.scanForSecrets(entry.text);
    const redacted = scan.redactionCount > 0;
    const passed = entry.kind === 'true_positive' ? redacted : !redacted;
    return {
      id: entry.id,
      kind: entry.kind,
      category: entry.category,
      expectedPattern: entry.expectedPattern,
      text: entry.text,
      redacted,
      firedPatterns: scan.firedPatterns,
      redactionCount: scan.redactionCount,
      passed,
    };
  }
}

function computeOverallMetrics(cases: SafetyCaseResult[]): SafetyOverallMetrics {
  let truePositives = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  for (const entry of cases) {
    if (entry.kind === 'true_positive') {
      if (entry.redacted) truePositives += 1;
      else falseNegatives += 1;
    } else if (entry.redacted) {
      falsePositives += 1;
    } else {
      trueNegatives += 1;
    }
  }
  const precision = truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  return { truePositives, falsePositives, trueNegatives, falseNegatives, precision, recall, f1 };
}

function computePerPatternMetrics(cases: SafetyCaseResult[]): SafetyPatternMetrics[] {
  return SECRET_PATTERN_NAMES.map((name) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const entry of cases) {
      const fired = entry.firedPatterns.includes(name);
      if (entry.kind === 'true_positive') {
        const expected = entry.expectedPattern === name;
        if (fired && expected) truePositives += 1;
        else if (!fired && expected) falseNegatives += 1;
        // fired && !expected on a TP case is treated as a benign overlap — it
        // does not count against precision because the redaction was warranted.
      } else if (fired) {
        falsePositives += 1;
      }
    }
    const precision = truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives);
    const recall = truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives);
    const f1 = precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
    return { name, truePositives, falsePositives, falseNegatives, precision, recall, f1 };
  });
}
