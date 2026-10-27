import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { projectPath } from './paths.js';

/** Applies pending migrations in order, each in its own transaction. Returns the files applied. */
export async function runMigrations(client: PoolClient, dir = projectPath('migrations')): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Two instances starting at once (e.g. api and worker) must not both migrate.
  await client.query('SELECT pg_advisory_lock(7253)');
  try {
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const done: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        done.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7253)');
  }
}
