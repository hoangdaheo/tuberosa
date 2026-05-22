import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SafetyEvaluator,
  loadSafetyFixture,
  type SafetyOverallMetrics,
  type SafetyPatternMetrics,
  type SafetyReport,
} from '../src/evaluation/safety-evaluator.js';

interface CliOptions {
  fixturePath: string;
  json: boolean;
  writeBaseline?: string;
  failUnderPrecision?: number;
  failUnderRecall?: number;
  failUnderF1?: number;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = await loadSafetyFixture(resolve(options.fixturePath));
  const evaluator = new SafetyEvaluator();
  const report = evaluator.run(fixture);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (options.writeBaseline) {
    const baseline = {
      fixtureName: report.fixtureName,
      recordedAt: report.evaluatedAt,
      totalCases: report.totalCases,
      overall: report.overall,
      perPattern: report.perPattern,
    };
    await writeFile(resolve(options.writeBaseline), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`\nbaseline written to ${options.writeBaseline}`);
  }

  if (shouldFail(report, options)) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: 'eval/safety-fixtures.json',
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--fixture') {
      options.fixturePath = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--write-baseline') {
      options.writeBaseline = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--fail-under-precision') {
      options.failUnderPrecision = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--fail-under-recall') {
      options.failUnderRecall = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--fail-under-f1') {
      options.failUnderF1 = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return options;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function readRate(value: string, option: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${option} must be a decimal rate from 0 to 1.`);
  }
  return parsed;
}

function printReport(report: SafetyReport): void {
  console.log(`Knowledge-safety eval: ${report.fixtureName}`);
  console.log(`Total cases: ${report.totalCases}`);
  console.log('');
  printOverall(report.overall);
  console.log('');
  printPerPattern(report.perPattern);
  console.log('');
  printFailures(report);
}

function printOverall(overall: SafetyOverallMetrics): void {
  console.log('Overall');
  console.log(`  TP: ${overall.truePositives}  FN: ${overall.falseNegatives}  FP: ${overall.falsePositives}  TN: ${overall.trueNegatives}`);
  console.log(`  precision: ${formatRate(overall.precision)}  recall: ${formatRate(overall.recall)}  F1: ${formatRate(overall.f1)}`);
}

function printPerPattern(perPattern: SafetyPatternMetrics[]): void {
  console.log('Per-pattern');
  for (const row of perPattern) {
    console.log(`  ${row.name}`);
    console.log(`    TP: ${row.truePositives}  FN: ${row.falseNegatives}  FP: ${row.falsePositives}`);
    console.log(`    precision: ${formatRate(row.precision)}  recall: ${formatRate(row.recall)}  F1: ${formatRate(row.f1)}`);
  }
}

function printFailures(report: SafetyReport): void {
  const failures = report.cases.filter((entry) => !entry.passed);
  if (failures.length === 0) {
    console.log('All cases passed.');
    return;
  }
  console.log('Failing cases');
  for (const entry of failures) {
    const status = entry.kind === 'true_positive' ? 'MISSED' : 'OVER-REDACT';
    console.log(`  ${status} ${entry.id} (${entry.category})`);
    console.log(`    expectedPattern=${entry.expectedPattern ?? 'none'} fired=[${entry.firedPatterns.join(', ')}] redactions=${entry.redactionCount}`);
    console.log(`    text="${truncate(entry.text)}"`);
  }
}

function shouldFail(report: SafetyReport, options: CliOptions): boolean {
  const failures: string[] = [];
  const { overall } = report;
  if (options.failUnderPrecision !== undefined && overall.precision !== null && overall.precision < options.failUnderPrecision) {
    failures.push(`precision ${overall.precision} < ${options.failUnderPrecision}`);
  }
  if (options.failUnderRecall !== undefined && overall.recall !== null && overall.recall < options.failUnderRecall) {
    failures.push(`recall ${overall.recall} < ${options.failUnderRecall}`);
  }
  if (options.failUnderF1 !== undefined && overall.f1 !== null && overall.f1 < options.failUnderF1) {
    failures.push(`f1 ${overall.f1} < ${options.failUnderF1}`);
  }
  if (failures.length > 0) {
    console.error(`\nThreshold violations: ${failures.join('; ')}`);
    return true;
  }
  return false;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function truncate(value: string, limit = 96): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function usage(): string {
  return [
    'Usage: pnpm run eval:safety -- [options]',
    '',
    'Options:',
    '  --fixture <path>             Fixture JSON path (default: eval/safety-fixtures.json)',
    '  --write-baseline <path>      Write metrics to this baseline file',
    '  --fail-under-precision <0-1> Exit non-zero when overall precision drops below the threshold',
    '  --fail-under-recall <0-1>    Exit non-zero when overall recall drops below the threshold',
    '  --fail-under-f1 <0-1>        Exit non-zero when overall F1 drops below the threshold',
    '  --json                       Print the full JSON report',
    '  -h, --help                   Show this help',
  ].join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
