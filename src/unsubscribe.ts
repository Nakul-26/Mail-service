import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UnsubscribeTarget {
  tenantId: string;
  email: string;
  topic: string;
}

// Stateless signed token: base64url(JSON payload) + "." + HMAC-SHA256. Nothing to store or expire;
// an unsubscribe link must keep working for as long as old newsletters sit in inboxes.
export function signUnsubscribe(target: UnsubscribeTarget, secret: string): string {
  const body = Buffer.from(JSON.stringify([target.tenantId, target.email, target.topic])).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyUnsubscribe(token: string, secret: string): UnsubscribeTarget | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const [tenantId, email, topic] = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if ([tenantId, email, topic].every((v) => typeof v === 'string')) return { tenantId, email, topic };
  } catch {
    // fall through
  }
  return null;
}

function mac(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}
