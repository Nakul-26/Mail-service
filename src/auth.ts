import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';

// Key format: elm_<prefix>_<secret>. The prefix is stored in clear for lookup,
// the full key only as a SHA-256 hash (keys are high-entropy, so no KDF needed).
export function generateApiKey() {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const key = `elm_${prefix}_${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

export function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export interface AppContext {
  appId: string;
  tenantId: string;
  product: string;
  defaultFrom: string;
  allowedSenders: string[];
  allowedRecipients: string[] | null;
  ratePerMinute: number;
  dailyQuota: number;
  maxBatchSize: number;
  appName: string;
}

export async function authenticate(header: string | undefined): Promise<AppContext | null> {
  const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const match = key && /^elm_([0-9a-f]{12})_[A-Za-z0-9_-]+$/.exec(key);
  if (!key || !match) return null;

  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.key_hash, a.id AS app_id, a.tenant_id, a.product, a.default_from,
            a.allowed_senders, a.allowed_recipients, a.rate_per_minute, a.daily_quota, a.max_batch_size, a.name AS app_name
       FROM api_keys k JOIN apps a ON a.id = k.app_id
      WHERE k.prefix = $1 AND k.revoked_at IS NULL AND a.disabled_at IS NULL`,
    [match[1]],
  );
  const row = rows[0];
  if (!row || !timingSafeEqual(Buffer.from(row.key_hash, 'hex'), Buffer.from(hashKey(key), 'hex'))) {
    return null;
  }
  // Best-effort, not awaited on the request path.
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => {});

  return {
    appId: row.app_id,
    tenantId: row.tenant_id,
    product: row.product,
    defaultFrom: row.default_from,
    allowedSenders: row.allowed_senders,
    allowedRecipients: row.allowed_recipients,
    ratePerMinute: row.rate_per_minute,
    dailyQuota: row.daily_quota,
    maxBatchSize: row.max_batch_size,
    appName: row.app_name,
  };
}
