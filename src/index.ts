import { createAppServices } from './app.js';
import { createHttpServer } from './http/server.js';

const services = await createAppServices();

// Fail-fast: do not bind to a non-loopback host with no authentication.
const isLoopbackHost = ['127.0.0.1', '::1', 'localhost'].includes(services.config.httpHost);
if (!isLoopbackHost && !services.config.apiKey && !services.config.requireApiKeyForNonLoopback) {
  console.error(
    `Refusing to start: TUBEROSA_HTTP_HOST=${services.config.httpHost} is not loopback, ` +
      `TUBEROSA_API_KEY is unset, and TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK=false. ` +
      `Set an API key or restore the loopback default.`,
  );
  await services.close();
  process.exit(1);
}

const server = createHttpServer(services);

server.listen(services.config.port, services.config.httpHost, () => {
  services.operations.startScheduledBackups();
  console.log(`Tuberosa HTTP server listening on http://${services.config.httpHost}:${services.config.port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down.`);
  server.close();
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
