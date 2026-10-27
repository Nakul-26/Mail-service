import { pool } from './db.js';
import { classifyPermanentFailure, recordEvent, type DeliveryEvent, type EventResult } from './events.js';

// Optional adapter: SES event publishing via SNS (POST /webhooks/ses). Not needed for self-hosted
// delivery; only used when a relay route is SES and SES_SNS_TOPIC_ARNS is set.
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
    bouncedRecipients: { emailAddress: string; status?: string; diagnosticCode?: string }[];
  };
  complaint?: { timestamp: string; complaintFeedbackType?: string };
  reject?: { reason: string };
  failure?: { errorMessage: string };
  deliveryDelay?: { timestamp: string; delayType: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function applySesEvent(snsMessageId: string, event: SesEvent): Promise<EventResult> {
  const messageId = await findMessage(event);
  if (!messageId) return 'unknown_message'; // e.g. other mail on a shared SES topic
  const ev = toDeliveryEvent(messageId, snsMessageId, event);
  return recordEvent(ev);
}

async function findMessage(event: SesEvent): Promise<string | null> {
  // Prefer our own tag; fall back to the SES message id saved from the SMTP response.
  const tagged = event.mail.tags?.eclipse_id?.[0];
  if (tagged && UUID.test(tagged)) return tagged;
  const { rows } = await pool.query('SELECT id FROM messages WHERE provider_message_id = $1', [event.mail.messageId]);
  return rows[0]?.id ?? null;
}

export function toDeliveryEvent(messageId: string, snsMessageId: string, event: SesEvent): DeliveryEvent {
  const type = event.eventType ?? event.notificationType ?? 'Unknown';
  const { mail: _mail, ...detail } = event; // mail repeats every header; not worth storing
  const base = { messageId, source: 'ses' as const, sourceEventId: snsMessageId, type, detail };
  switch (type) {
    case 'Delivery':
      // SES "Delivery" means the recipient's server accepted it, not that it reached the inbox.
      return { ...base, status: 'accepted_remote', occurredAt: event.delivery?.timestamp };
    case 'Bounce': {
      const b = event.bounce!;
      const r = b.bouncedRecipients[0];
      const diagnostic = r?.diagnosticCode ?? `${b.bounceType}/${b.bounceSubType}`;
      if (b.bounceType !== 'Permanent') {
        return { ...base, status: 'bounced', error: diagnostic, occurredAt: b.timestamp };
      }
      const policy = classifyPermanentFailure(r?.status);
      return {
        ...base,
        status: policy.status,
        error: diagnostic,
        occurredAt: b.timestamp,
        // SES only reports "Permanent" for unusable addresses unless the code says it was a policy refusal.
        suppress: policy.status === 'rejected' ? undefined : { scope: 'all', reason: 'hard_bounce', detail: diagnostic },
      };
    }
    case 'Complaint':
      return {
        ...base,
        occurredAt: event.complaint?.timestamp,
        suppress: { scope: 'topic', reason: 'complaint', detail: event.complaint?.complaintFeedbackType ?? 'complaint' },
      };
    case 'Reject':
    case 'Rendering Failure':
      return { ...base, status: 'failed', error: event.reject?.reason ?? event.failure?.errorMessage ?? type };
    case 'DeliveryDelay':
      return { ...base, status: 'mta_deferred', error: event.deliveryDelay?.delayType, occurredAt: event.deliveryDelay?.timestamp };
    default:
      return base; // Send, Open, Click: recorded, no state change
  }
}
