// API keys, one or more per app, each independently revocable.
//
//   npm run keys -- create <tenant> <app-name>     prints the new key once
//   npm run keys -- list <tenant> <app-name>
//   npm run keys -- revoke <key-prefix>            e.g. the "a1b2c3d4e5f6" in elm_a1b2c3d4e5f6_...
import { audit } from '../src/audit.js';
import { generateApiKey } from '../src/auth.js';
import { pool } from '../src/db.js';

const [command, a, b] = process.argv.slice(2);

async function appId(tenant: string, app: string): Promise<string> {
  const { rows } = await pool.query(
    'SELECT a.id FROM apps a JOIN tenants t ON t.id = a.tenant_id WHERE t.name = $1 AND a.name = $2',
    [tenant, app],
  );
  if (!rows[0]) throw new Error(`no app "${app}" in tenant "${tenant}"`);
  return rows[0].id;
}

try {
  if (command === 'create' && a && b) {
    const id = await appId(a, b);
    const { key, prefix, hash } = generateApiKey();
    await pool.query('INSERT INTO api_keys (app_id, prefix, key_hash) VALUES ($1, $2, $3)', [id, prefix, hash]);
    await audit(pool, 'key.create', `${a}/${b}`, { prefix });
    console.log(`API key for ${a}/${b} (shown once, store it securely):\n${key}`);
  } else if (command === 'list' && a && b) {
    const { rows } = await pool.query(
      'SELECT prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE app_id = $1 ORDER BY created_at',
      [await appId(a, b)],
    );
    for (const r of rows) {
      console.log(`${r.prefix}  created ${r.created_at.toISOString()}  last used ${r.last_used_at?.toISOString() ?? 'never'}  ${r.revoked_at ? `REVOKED ${r.revoked_at.toISOString()}` : 'active'}`);
    }
  } else if (command === 'revoke' && a) {
    const { rows } = await pool.query(
      `UPDATE api_keys k SET revoked_at = now() FROM apps ap JOIN tenants t ON t.id = ap.tenant_id
        WHERE k.prefix = $1 AND k.revoked_at IS NULL AND ap.id = k.app_id
        RETURNING t.name AS tenant, ap.name AS app`,
      [a],
    );
    if (!rows[0]) throw new Error(`no active key with prefix ${a}`);
    await audit(pool, 'key.revoke', `${rows[0].tenant}/${rows[0].app}`, { prefix: a });
    console.log(`revoked ${a} (${rows[0].tenant}/${rows[0].app}); it stops working immediately`);
  } else {
    throw new Error('usage: npm run keys -- create|list <tenant> <app-name> | revoke <key-prefix>');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
