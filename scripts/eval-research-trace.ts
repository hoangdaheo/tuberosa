import { resolve } from 'node:path';
import {
  loadResearchTraceFixture,
  ResearchTraceEvaluator,
  type ResearchTraceEvalReport,
} from '../src/evaluation/research-trace-evaluator.js';

interface CliOptions {
  fixturePath: string;
  json: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await loadResearchTraceFixture(resolve(options.fixturePath));
  const report = new ResearchTraceEvaluator().run(fixture);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.passedCases !== report.totalCases) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: 'eval/research-trace-fixtures.json',
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--fixture') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--fixture requires a value.');
      }
      options.fixturePath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printReport(report: ResearchTraceEvalReport): void {
  console.log(`Research trace eval: ${report.fixtureName}`);
  console.log(`Cases: ${report.passedCases}/${report.totalCases}`);
  for (const testCase of report.cases) {
    const status = testCase.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${testCase.id}: derived=${testCase.derived} steps=${testCase.stepCount}`);
    for (const failure of testCase.failures) {
      console.log(`    ${failure}`);
    }
  }
}

await main();
