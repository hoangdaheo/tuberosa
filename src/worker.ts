import { createAppServices } from './app.js';
import type { AppServices } from './app.js';
import { runArchivalSweep } from './atoms/archival.js';
import { inferCoChangeLinks } from './atoms/inference/co-change.js';
import { pruneStaleEdges } from './atoms/inference/prune.js';
import { clusterUserCorrections } from './user-style/clusterer.js';

let services: AppServices;
try {
  services = await createAppServices();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[tuberosa] worker startup failed: ${message}\n`);
  process.stderr.write(
    "[tuberosa] If the store is unreachable, run 'npx tuberosa init' first, " +
      'or set TUBEROSA_EMBEDDED=1 for volatile trial mode.\n',
  );
  process.exit(1);
}

console.log('Tuberosa worker started. Ingestion is currently API-driven; queued jobs can be added behind this process.');

let archivalTimer: NodeJS.Timeout | undefined;
if (services.config.archival.enabled) {
  const intervalMs = services.config.archival.intervalHours * 60 * 60 * 1000;
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
if (services.config.graphInference.enabled && services.config.defaultProject) {
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

// Concern F — scheduled user-correction clustering. Skipped when the layer is
// disabled or TUBEROSA_USER_ID is unset.
let userStyleClusterTimer: NodeJS.Timeout | undefined;
if (services.config.userStyle.enabled !== false && services.config.userStyle.userId) {
  const intervalMs = (services.config.userStyle.clusterIntervalHours ?? 1) * 60 * 60 * 1000;
  const userId = services.config.userStyle.userId;
  const windowDays = services.config.userStyle.clusterWindowDays ?? 30;
  const minClusterEvents = services.config.userStyle.minClusterEvents ?? 3;
  const run = async () => {
    try {
      const report = await clusterUserCorrections(services.store, services.models, {
        userId,
        windowDays,
        minClusterEvents,
      });
      process.stderr.write(`[user-style-clusterer] ${JSON.stringify(report)}\n`);
    } catch (error) {
      process.stderr.write(`[user-style-clusterer] failed: ${(error as Error).message}\n`);
    }
  };
  userStyleClusterTimer = setInterval(() => void run(), intervalMs);
}

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}, shutting down.`);
  if (archivalTimer) clearInterval(archivalTimer);
  if (coChangeTimer) clearInterval(coChangeTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (userStyleClusterTimer) clearInterval(userStyleClusterTimer);
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
