import { createAppServices } from './app.js';
import { createHttpServer } from './http/server.js';

const services = await createAppServices();
const server = createHttpServer(services);

server.listen(services.config.port, () => {
  console.log(`Tuberosa HTTP server listening on http://localhost:${services.config.port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down.`);
  server.close();
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
