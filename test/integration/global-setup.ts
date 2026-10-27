import pg from 'pg';
import { runMigrations } from '../../src/migrations.js';

// Recreates the test database from the migrations, so every run starts clean.
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://mail:mail@localhost:5440/mail_test');
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(dbName)) {
    throw new Error(`refusing to wipe "${dbName}": the test database name must contain "test"`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: url.toString() });
  const client = await pool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
    await pool.end();
  }
}
