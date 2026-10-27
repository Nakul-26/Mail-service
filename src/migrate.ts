import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from './db.js';

const dir = join(import.meta.dirname, '..', 'migrations');

const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  console.log('migrations up to date');
} finally {
  client.release();
  await pool.end();
}
