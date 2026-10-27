// Parsers for bounce (DSN, RFC 3464) and complaint (ARF, RFC 5965) reports received by the
// bounce receiver. They work on already-decoded MIME parts so they stay pure and testable.

export interface DsnRecipient {
  finalRecipient?: string;
  action: string; // failed | delayed | delivered | relayed | expanded
  status: string; // enhanced status code, e.g. 5.1.1
  diagnosticCode?: string;
  remoteMta?: string;
}

/** Parses a message/delivery-status body: one per-message block, then one block per recipient. */
export function parseDeliveryStatus(body: string): DsnRecipient[] {
  const blocks = unfold(body)
    .split(/\r?\n\s*\r?\n/)
    .map(parseFields)
    .filter((f) => Object.keys(f).length > 0);
  return blocks
    .filter((f) => f['action'] && f['status'])
    .map((f) => ({
      finalRecipient: stripType(f['final-recipient']),
      action: f['action']!.toLowerCase(),
      status: /\d\.\d{1,3}\.\d{1,3}/.exec(f['status']!)?.[0] ?? f['status']!,
      diagnosticCode: f['diagnostic-code'],
      remoteMta: stripType(f['remote-mta']),
    }));
}

export interface FeedbackReport {
  feedbackType: string; // abuse | fraud | not-spam | ...
  originalMailFrom?: string;
}

export function parseFeedbackReport(body: string): FeedbackReport | null {
  const f = parseFields(unfold(body));
  if (!f['feedback-type']) return null;
  return { feedbackType: f['feedback-type'].toLowerCase(), originalMailFrom: f['original-mail-from'] };
}

/** Header fields of the original message included in a report (message/rfc822 or text/rfc822-headers). */
export function originalHeaders(raw: string): Record<string, string> {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  return parseFields(unfold(head));
}

function unfold(s: string) {
  return s.replace(/\r?\n[ \t]+/g, ' ');
}

function parseFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m && !(m[1]!.toLowerCase() in out)) out[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return out;
}

function stripType(v: string | undefined) {
  return v?.replace(/^[a-z0-9-]+;\s*/i, '').replace(/^<|>$/g, '').toLowerCase();
}

export interface MimePart {
  contentType: string;
  body: string;
}

export interface Report {
  subject?: string;
  parts: MimePart[];
}

/**
 * Splits a multipart/report message (RFC 6522) into its parts. Bounce and complaint reports are a
 * single, flat multipart, so this deliberately handles one level and the usual transfer encodings.
 * (General-purpose parsers such as mailparser drop message/delivery-status parts.)
 */
export function parseReport(raw: string): Report {
  const { headers, body } = splitHeaders(raw);
  const contentType = headers['content-type'] ?? 'text/plain';
  const subject = headers['subject'];
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!/^multipart\//i.test(contentType) || !boundary) return { subject, parts: [] };

  const parts: MimePart[] = [];
  const sections = body.split(new RegExp(`^--${escapeRegExp(boundary)}(?:--)?[ \t]*\r?$`, 'm'));
  for (const section of sections.slice(1, -1)) {
    const part = splitHeaders(section.replace(/^\r?\n/, ''));
    const type = (part.headers['content-type'] ?? 'text/plain').split(';')[0]!.trim().toLowerCase();
    parts.push({ contentType: type, body: decode(part.body, part.headers['content-transfer-encoding']) });
  }
  return { subject, parts };
}

function splitHeaders(raw: string) {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  return { headers: parseFields(unfold(head)), body };
}

function decode(body: string, encoding: string | undefined) {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
