import type { Pool, PoolClient } from 'pg';

/**
 * Returns the reason the recipient must not receive this message, or null.
 * Transactional mail is only blocked by scope 'all'; marketing mail also by its topic.
 */
export async function findSuppression(
  db: Pool | PoolClient,
  tenantId: string,
  email: string,
  topic: string | null,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT reason FROM suppressions
      WHERE tenant_id = $1 AND email = $2 AND (scope = 'all' OR scope = $3)
      ORDER BY scope = 'all' DESC LIMIT 1`,
    [tenantId, email, topic],
  );
  return rows[0]?.reason ?? null;
}
