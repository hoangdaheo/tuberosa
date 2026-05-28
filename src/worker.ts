import { createAppServices } from './app.js';
import { runArchivalSweep } from './atoms/archival.js';
import { inferCoChangeLinks } from './atoms/inference/co-change.js';
import { pruneStaleEdges } from './atoms/inference/prune.js';

const services = await createAppServices();

console.log('Tuberosa worker started. Ingestion is currently API-driven; queued jobs can be added behind this process.');

let archivalTimer: NodeJS.Timeout | undefined;
if (services.config.archivalEnabled) {
  const intervalMs = services.config.archivalIntervalHours * 60 * 60 * 1000;
  const sweep = async () => {
    try {
      const report = await runArchivalSweep(services.store);
      const archived = report.archivedByTime.length + report.archivedBySignal.length;
      process.stderr.write(`[archival] swept ${report.scanned}, archived ${archived}\n`);
    } catch (error) {
      process.stderr.write(`[archival] sweep failed: ${(error as Error).message}\n`);
    }
  };
  archivalTimer = setInterval(() => void sweep(), intervalMs);
  void sweep(); // run once on startup
}

// Concern C1 — scheduled graph inference. Co-change runs daily; stale-edge
// prune runs weekly. Both are no-ops when defaultProject is unset, since the
// jobs are project-scoped.
let coChangeTimer: NodeJS.Timeout | undefined;
let pruneTimer: NodeJS.Timeout | undefined;
if (services.config.graphInferenceEnabled && services.config.defaultProject) {
  const project = services.config.defaultProject;
  const cwd = services.config.defaultCwd ?? process.cwd();

  const coChangeIntervalMs = 24 * 60 * 60 * 1000;
  const runCoChange = async () => {
    try {
      const report = await inferCoChangeLinks(services.store, { project, cwd });
      process.stderr.write(`[co-change] ${JSON.stringify(report)}\n`);
    } catch (error) {
      process.stderr.write(`[co-change] failed: ${(error as Error).message}\n`);
    }
  };
  coChangeTimer = setInterval(() => void runCoChange(), coChangeIntervalMs);
  void runCoChange();

  const pruneIntervalMs = 7 * 24 * 60 * 60 * 1000;
  const runPrune = async () => {
    try {
      const report = await pruneStaleEdges(services.store, { project });
      process.stderr.write(`[edge-prune] ${JSON.stringify(report)}\n`);
    } catch (error) {
      process.stderr.write(`[edge-prune] failed: ${(error as Error).message}\n`);
    }
  };
  pruneTimer = setInterval(() => void runPrune(), pruneIntervalMs);
}

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}, shutting down.`);
  if (archivalTimer) clearInterval(archivalTimer);
  if (coChangeTimer) clearInterval(coChangeTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
