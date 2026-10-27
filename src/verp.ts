import { createHmac, timingSafeEqual } from 'node:crypto';

// VERP return path: bounce+<message id without dashes>-<mac>@<domain>.
// Every bounce or DSN sent back to this address identifies its message. The MAC stops anyone from
// making up an address for another message. A recipient who reads their own Return-Path can at most
// report a bounce for the one message they received.

export function verpAddress(messageId: string, domain: string, secret: string): string {
  const hex = messageId.replace(/-/g, '').toLowerCase();
  return `bounce+${hex}-${mac(hex, secret)}@${domain}`;
}

/** Returns the message id encoded in a VERP address, or null if it isn't a valid one of ours. */
export function parseVerp(address: string, secret: string): string | null {
  const m = /^<?bounce\+([0-9a-f]{32})-([0-9a-f]{12})@/i.exec(address.trim());
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  const given = Buffer.from(m[2]!.toLowerCase());
  const expected = Buffer.from(mac(hex, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Hex, so the local part survives servers that change letter case.
function mac(hex: string, secret: string) {
  return createHmac('sha256', secret).update(`verp:${hex}`).digest('hex').slice(0, 12);
}
