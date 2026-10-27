import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = buildApp();
await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}
