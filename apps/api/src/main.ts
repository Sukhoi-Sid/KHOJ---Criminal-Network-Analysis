import { createApp } from './app';
import { env } from './core/env';
import { prisma } from './core/db';
import { closeGraphDriver } from './core/neo4j';

async function main() {
  const app = createApp();

  const server = app.listen(env.API_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`SIH 26189 API listening on port ${env.API_PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    await prisma.$disconnect();
    await closeGraphDriver();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
