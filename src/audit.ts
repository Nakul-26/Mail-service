import { userInfo } from 'node:os';
import type { Pool, PoolClient } from 'pg';

/** Who is running an admin command: ADMIN_ACTOR if set (e.g. a name), else the OS user. */
export function currentActor(): string {
  if (process.env.ADMIN_ACTOR) return process.env.ADMIN_ACTOR;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** Records an administrative change. Never pass secrets (API keys, private keys) in details. */
export async function audit(db: Pool | PoolClient, action: string, target: string, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO admin_audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)', [
    currentActor(),
    action,
    target,
    JSON.stringify(details),
  ]);
}
