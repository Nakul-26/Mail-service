// Usage: npm run create-app -- <tenant> <app-name> <product> <from-address> [extra allowed senders...]
// Creates the tenant if needed, the app, and one API key. The key is printed once and never stored.
import { generateApiKey } from '../src/auth.js';
import { pool } from '../src/db.js';

const [tenantName, appName, product, from, ...extraSenders] = process.argv.slice(2);
if (!tenantName || !appName || !product || !from) {
  console.error('usage: npm run create-app -- <tenant> <app-name> <product> <from-address> [senders...]');
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const tenant = await client.query(
    `INSERT INTO tenants (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [tenantName],
  );
  const app = await client.query(
    `INSERT INTO apps (tenant_id, name, product, default_from, allowed_senders)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenant.rows[0].id, appName, product, from.toLowerCase(), [from, ...extraSenders].map((s) => s.toLowerCase())],
  );
  const { key, prefix, hash } = generateApiKey();
  await client.query('INSERT INTO api_keys (app_id, prefix, key_hash) VALUES ($1, $2, $3)', [
    app.rows[0].id,
    prefix,
    hash,
  ]);
  await client.query('COMMIT');
  console.log(`app ${appName} (${app.rows[0].id}) created for tenant ${tenantName}`);
  console.log(`API key (shown once, store it securely):\n${key}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
