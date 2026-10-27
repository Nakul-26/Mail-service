// Parses the Postfix log lines that matter for delivery tracking (maillog_file format,
// "<timestamp> <host> postfix/<service>[<pid>]: <queue id>: <details>"):
//
//   postfix/cleanup[..]: 4ZqK1x: message-id=<6f1c...@notify.example.com>
//   postfix/smtp[..]:    4ZqK1x: to=<a@gmail.com>, relay=gmail-smtp-in.l.google.com[1.2.3.4]:25, ...,
//                        dsn=2.0.0, status=sent (250 2.0.0 OK ...)
//   postfix/qmgr[..]:    4ZqK1x: from=<...>, status=expired, returned to sender

export type PostfixLogEvent =
  | { kind: 'message-id'; queueId: string; messageId: string }
  | {
      kind: 'delivery';
      queueId: string;
      to: string;
      relay: string;
      dsn: string;
      status: 'sent' | 'deferred' | 'bounced';
      response: string;
    }
  | { kind: 'expired'; queueId: string };

const PREFIX = /\bpostfix[\w.-]*\/([\w-]+)\[\d+\]: ([0-9A-Za-z]{6,}): (.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePostfixLine(line: string): PostfixLogEvent | null {
  const m = PREFIX.exec(line.trimEnd());
  if (!m) return null;
  const [, service, queueId, rest] = m as unknown as [string, string, string, string];

  if (service === 'cleanup') {
    const id = /^message-id=<([^@>]+)@[^>]*>/.exec(rest)?.[1];
    // Only our messages: their Message-ID is <uuid@domain>.
    return id && UUID.test(id) ? { kind: 'message-id', queueId, messageId: id.toLowerCase() } : null;
  }

  const delivery = /^to=<([^>]*)>,(?:.*?\brelay=([^,]+),)?.*?\bdsn=(\d\.\d{1,3}\.\d{1,3}), status=(sent|deferred|bounced) \((.*)\)$/.exec(rest);
  if (delivery) {
    const [, to, relay, dsn, status, response] = delivery as unknown as [string, string, string | undefined, string, string, string];
    return { kind: 'delivery', queueId, to: to.toLowerCase(), relay: relay ?? 'none', dsn, status: status as 'sent', response };
  }

  if (service === 'qmgr' && /\bstatus=expired\b/.test(rest)) return { kind: 'expired', queueId };
  return null;
}
