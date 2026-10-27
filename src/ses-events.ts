import { pool } from './db.js';

// Applies one SES event (from event publishing via SNS) to our message records.
// https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html

export interface SesEvent {
  eventType?: string;
  notificationType?: string; // name used when SES sends identity notifications instead of event publishing
  mail: { messageId: string; tags?: Record<string, string[]> };
  delivery?: { timestamp: string; smtpResponse?: string };
  bounce?: {
    bounceType: string;
    bounceSubType: string;
    timestamp: string;
    bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[];
  };
  complaint?: { timestamp: string; complaintFeedbackType?: string };
  reject?: { reason: string };
  failure?: { errorMessage: string };
  deliveryDelay?: { timestamp: string; delayType: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ApplyResult = 'applied' | 'duplicate' | 'unknown_message';

export async function applySesEvent(snsMessageId: string, event: SesEvent): Promise<ApplyResult> {
  const type = event.eventType ?? event.notificationType ?? 'Unknown';
  const tagged = event.mail.tags?.eclipse_id?.[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Prefer our own tag; fall back to the SES message id saved from the SMTP response.
    const found = await client.query(
      `SELECT m.id, m.topic, m.to_addr, a.tenant_id
         FROM messages m JOIN apps a ON a.id = m.app_id
        WHERE ${tagged && UUID.test(tagged) ? 'm.id = $1' : 'm.provider_message_id = $1'}
        FOR UPDATE OF m`,
      [tagged && UUID.test(tagged) ? tagged : event.mail.messageId],
    );
    const msg = found.rows[0];
    if (!msg) {
      // E.g. other mail on a shared SES topic. Nothing of ours to update.
      await client.query('ROLLBACK');
      return 'unknown_message';
    }

    const occurredAt =
      event.delivery?.timestamp ?? event.bounce?.timestamp ?? event.complaint?.timestamp ??
      event.deliveryDelay?.timestamp ?? null;
    const inserted = await client.query(
      `INSERT INTO message_events (message_id, provider, provider_event_id, event_type, detail, occurred_at)
       VALUES ($1, 'ses', $2, $3, $4, $5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [msg.id, snsMessageId, type, eventDetail(event), occurredAt],
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }

    const suppress = (scope: string, reason: string, detail: string) =>
      client.query(
        `INSERT INTO suppressions (tenant_id, email, scope, reason, detail) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [msg.tenant_id, msg.to_addr, scope, reason, detail],
      );

    switch (type) {
      case 'Delivery':
        await client.query(
          `UPDATE messages SET status = 'delivered', delivered_at = $2, updated_at = now()
            WHERE id = $1 AND status = 'sent'`,
          [msg.id, occurredAt],
        );
        break;
      case 'Bounce': {
        const b = event.bounce!;
        const diagnostic = b.bouncedRecipients[0]?.diagnosticCode ?? `${b.bounceType}/${b.bounceSubType}`;
        await client.query(
          `UPDATE messages SET status = 'bounced', last_error = $2, updated_at = now()
            WHERE id = $1 AND status IN ('sent', 'delivered')`,
          [msg.id, diagnostic.slice(0, 1000)],
        );
        // Permanent = the address doesn't exist or SES won't send to it. Transient bounces
        // (mailbox full, etc.) are not suppressed; a later message may get through.
        if (b.bounceType === 'Permanent') await suppress('all', 'hard_bounce', diagnostic);
        break;
      }
      case 'Complaint':
        // Marked as spam. For newsletters, stop only that topic, so the person still gets OTPs and
        // exam mail; a complaint about transactional mail stops everything.
        await suppress(msg.topic ?? 'all', 'complaint', event.complaint?.complaintFeedbackType ?? 'complaint');
        break;
      case 'Reject':
      case 'Rendering Failure':
        await client.query(
          `UPDATE messages SET status = 'failed', last_error = $2, updated_at = now()
            WHERE id = $1 AND status IN ('sent', 'delivered')`,
          [msg.id, event.reject?.reason ?? event.failure?.errorMessage ?? type],
        );
        break;
      // Send, DeliveryDelay, Open, Click: recorded above, no state change.
    }
    await client.query('COMMIT');
    return 'applied';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The event without the mail object (which repeats all headers); that is kept on the message. */
function eventDetail(event: SesEvent) {
  const { mail: _mail, ...rest } = event;
  return rest;
}
