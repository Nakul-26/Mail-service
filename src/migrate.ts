import { pool } from './db.js';
import { runMigrations } from './migrations.js';

const client = await pool.connect();
try {
  for (const file of await runMigrations(client)) console.log(`applied ${file}`);
  console.log('migrations up to date');
} finally {
  client.release();
  await pool.end();
}
