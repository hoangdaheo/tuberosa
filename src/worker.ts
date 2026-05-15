import { createAppServices } from './app.js';

const services = await createAppServices();

console.log('Tuberosa worker started. Ingestion is currently API-driven; queued jobs can be added behind this process.');

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}, shutting down.`);
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
