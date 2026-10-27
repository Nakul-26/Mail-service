import { randomUUID } from 'node:crypto';
import { generateApiKey } from '../../src/auth.js';
import { pool } from '../../src/db.js';

export { pool };

/** Creates a tenant + app + API key directly in the database. Returns the key and ids. */
export async function createApp(opts: {
  product: 'exam' | 'placement' | 'alumni';
  from: string;
  tenant?: string;
  dailyQuota?: number;
  maxBatchSize?: number;
  allowedRecipients?: string[] | null;
}) {
  const tenantName = opts.tenant ?? `tenant-${randomUUID().slice(0, 8)}`;
  const t = await pool.query(
    `INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [tenantName],
  );
  const a = await pool.query(
    `INSERT INTO apps (tenant_id, name, product, default_from, allowed_senders, daily_quota, max_batch_size, allowed_recipients)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [t.rows[0].id, `app-${randomUUID().slice(0, 8)}`, opts.product, opts.from, [opts.from], opts.dailyQuota ?? 20000, opts.maxBatchSize ?? 10000, opts.allowedRecipients ?? null],
  );
  const { key, prefix, hash } = generateApiKey();
  await pool.query('INSERT INTO api_keys (app_id, prefix, key_hash) VALUES ($1, $2, $3)', [a.rows[0].id, prefix, hash]);
  return { key, prefix, appId: a.rows[0].id as string, tenantId: t.rows[0].id as string, auth: { authorization: `Bearer ${key}` } };
}

export async function verifyDomain(domain: string) {
  await pool.query(
    `INSERT INTO sender_domains (domain, dkim_selector, dkim_public, verified_at) VALUES ($1, 's1', 'test', now())
     ON CONFLICT (domain) DO UPDATE SET verified_at = now()`,
    [domain],
  );
}

export async function status(id: string): Promise<string> {
  const { rows } = await pool.query('SELECT status::text FROM messages WHERE id = $1', [id]);
  return rows[0]?.status;
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!ok(last)) {
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 200));
    last = await fn();
  }
  return last;
}
