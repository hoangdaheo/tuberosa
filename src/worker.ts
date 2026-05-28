import { createAppServices } from './app.js';
import { runArchivalSweep } from './atoms/archival.js';

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

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}, shutting down.`);
  if (archivalTimer) clearInterval(archivalTimer);
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
