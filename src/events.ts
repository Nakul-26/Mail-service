import type { PoolClient } from 'pg';
import { pool } from './db.js';

// One place where delivery evidence changes message state, whatever its source:
// Postfix's log, DSN/complaint emails, or the optional SES adapter.

export type EventSource = 'postfix-log' | 'dsn' | 'arf' | 'ses';

export type TargetStatus = 'mta_deferred' | 'accepted_remote' | 'delivered' | 'bounced' | 'rejected' | 'failed';

export interface DeliveryEvent {
  messageId: string;
  source: EventSource;
  /** Unique per source; a replayed event with the same id is ignored. */
  sourceEventId: string;
  type: string;
  status?: TargetStatus;
  error?: string;
  occurredAt?: Date | string | null;
  /** 'all' blocks every message to the recipient; 'topic' only the message's newsletter topic. */
  suppress?: { scope: 'all' | 'topic'; reason: 'hard_bounce' | 'complaint'; detail: string };
  detail: unknown;
}

export type EventResult = 'applied' | 'duplicate' | 'unknown_message' | 'not_ready';

export async function recordEvent(ev: DeliveryEvent): Promise<EventResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await recordEventIn(client, ev);
    await client.query(result === 'applied' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function recordEventIn(client: PoolClient, ev: DeliveryEvent): Promise<EventResult> {
  const found = await client.query(
    `SELECT m.id, m.status, m.topic, m.to_addr, a.tenant_id
       FROM messages m JOIN apps a ON a.id = m.app_id
      WHERE m.id = $1
      FOR UPDATE OF m`,
    [ev.messageId],
  );
  const msg = found.rows[0];
  if (!msg) return 'unknown_message';
  // The worker hasn't recorded the hand-off yet (the MTA can be faster than our commit).
  // The caller keeps the event and tries again shortly.
  if (msg.status === 'sending') return 'not_ready';

  const inserted = await client.query(
    `INSERT INTO message_events (message_id, provider, provider_event_id, event_type, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [ev.messageId, ev.source, ev.sourceEventId, ev.type, JSON.stringify(ev.detail ?? {}), ev.occurredAt ?? null],
  );
  if (inserted.rowCount === 0) return 'duplicate';

  if (ev.status) {
    await client.query(
      `UPDATE messages
          SET status = $2::message_status, updated_at = now(),
              last_error = COALESCE($3, last_error),
              accepted_remote_at = CASE WHEN $2::text = 'accepted_remote' THEN COALESCE($4, now()) ELSE accepted_remote_at END,
              delivered_at = CASE WHEN $2::text = 'delivered' THEN COALESCE($4, now()) ELSE delivered_at END
        WHERE id = $1 AND status_rank(status) < status_rank($2::message_status)`,
      [ev.messageId, ev.status, ev.error?.slice(0, 1000) ?? null, ev.occurredAt ?? null],
    );
  }
  if (ev.suppress) {
    await client.query(
      `INSERT INTO suppressions (tenant_id, email, scope, reason, detail) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        msg.tenant_id,
        msg.to_addr,
        ev.suppress.scope === 'topic' && msg.topic ? msg.topic : 'all',
        ev.suppress.reason,
        ev.suppress.detail.slice(0, 1000),
      ],
    );
  }
  return 'applied';
}

/**
 * Classifies a final SMTP failure from the recipient's server by its enhanced status code.
 * 5.1.x (bad address/mailbox) and 5.2.1 (disabled) mean the address is unusable: suppress it.
 * 5.7.x is a policy/spam refusal about *us*, not the address: 'rejected', never suppressed.
 */
export function classifyPermanentFailure(dsn: string | undefined): {
  status: 'bounced' | 'rejected';
  suppressAddress: boolean;
} {
  const code = dsn ?? '';
  if (/^5\.7\./.test(code)) return { status: 'rejected', suppressAddress: false };
  if (/^5\.1\.(1|2|3|6|10)$/.test(code) || code === '5.2.1') return { status: 'bounced', suppressAddress: true };
  return { status: 'bounced', suppressAddress: false };
}
