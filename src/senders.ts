import type { AppContext } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';

// Apps may only send from addresses they are allowed to use, on domains we have verified
// (DKIM key published, SPF and DMARC present; see `npm run domain -- verify`).

let cache: { domains: Set<string>; at: number } | null = null;
const TTL_MS = 30_000;

export async function verifiedDomains(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.domains;
  const { rows } = await pool.query('SELECT domain FROM sender_domains WHERE verified_at IS NOT NULL');
  cache = { domains: new Set(rows.map((r) => r.domain)), at: Date.now() };
  return cache.domains;
}

export type SenderCheck = { ok: true; from: string } | { ok: false; error: 'sender_not_allowed' | 'sender_domain_not_verified'; from: string };

export async function checkSender(ctx: AppContext, requested: string | undefined): Promise<SenderCheck> {
  const from = (requested ?? ctx.defaultFrom).toLowerCase();
  if (!ctx.allowedSenders.map((s) => s.toLowerCase()).includes(from)) return { ok: false, error: 'sender_not_allowed', from };
  if (config.ALLOW_UNVERIFIED_SENDER_DOMAINS) return { ok: true, from };
  const domain = from.split('@')[1]!;
  if (!(await verifiedDomains()).has(domain)) return { ok: false, error: 'sender_domain_not_verified', from };
  return { ok: true, from };
}
