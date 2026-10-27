import { createHash } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { classifyPermanentFailure, recordEvent, type DeliveryEvent, type EventResult } from './events.js';
import { originalHeaders, parseDeliveryStatus, parseFeedbackReport, parseReport, type Report } from './dsn.js';
import { parseVerp } from './verp.js';

// Internal SMTP listener that Postfix hands bounce-domain mail to (transport_maps). It is only
// reachable on the internal Docker network; Postfix is the only client.
//
// - DSNs to bounce+<id>-<mac>@<bounce domain>: the recipient address itself identifies and
//   authenticates the message. Covers Postfix's own bounce notices and later bounces from remote servers.
// - Complaint (ARF) reports to fbl@<bounce domain>: trusted only if the reported original message
//   carries one of our valid VERP return paths.
// Anything else is refused, so this can't be used to inject events for arbitrary messages.

const MAX_SIZE = 2 * 1024 * 1024;

export interface ReportOutcome {
  results: EventResult[];
}

export function createBounceReceiver(bounceSecret: string, log = console) {
  return new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: MAX_SIZE,
    banner: 'eclipse-mail bounce receiver',
    onRcptTo(address, _session, cb) {
      const rcpt = address.address.toLowerCase();
      if (parseVerp(rcpt, bounceSecret) || /^fbl@/.test(rcpt)) return cb();
      cb(Object.assign(new Error('5.1.1 unknown recipient'), { responseCode: 550 }));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', async () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          return cb(Object.assign(new Error('5.3.4 message too big'), { responseCode: 552 }));
        }
        try {
          const raw = Buffer.concat(chunks);
          const rcpts = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
          const { results } = await handleReport(raw, rcpts, bounceSecret);
          log.info?.(`bounce receiver: ${rcpts.join(',')} -> ${results.join(',') || 'nothing to apply'}`);
          // Not ready = the worker hasn't recorded the hand-off yet. 4xx makes Postfix retry later.
          if (results.includes('not_ready')) {
            return cb(Object.assign(new Error('4.3.0 try again shortly'), { responseCode: 451 }));
          }
          cb();
        } catch (err) {
          log.error?.('bounce receiver error', err);
          cb(Object.assign(new Error('4.3.0 temporary failure'), { responseCode: 451 }));
        }
      });
    },
  });
}

export async function handleReport(raw: Buffer, rcpts: string[], bounceSecret: string): Promise<ReportOutcome> {
  const parsed = parseReport(raw.toString('utf8'));
  const reportId = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const results: EventResult[] = [];
  for (const rcpt of rcpts) {
    const messageId = parseVerp(rcpt, bounceSecret);
    if (messageId) {
      for (const ev of dsnEvents(parsed, messageId, reportId)) results.push(await recordEvent(ev));
    } else if (/^fbl@/.test(rcpt)) {
      const ev = complaintEvent(parsed, reportId, bounceSecret);
      if (ev) results.push(await recordEvent(ev));
    }
  }
  return { results };
}

function partText(report: Report, types: string[]): string | null {
  return report.parts.find((p) => types.includes(p.contentType))?.body ?? null;
}

export function dsnEvents(mail: Report, messageId: string, reportId: string): DeliveryEvent[] {
  const status = partText(mail, ['message/delivery-status', 'message/global-delivery-status']);
  if (!status) return []; // not a DSN (auto-reply, etc.): nothing trustworthy to apply
  const base = { messageId, source: 'dsn' as const, sourceEventId: reportId };
  return parseDeliveryStatus(status).flatMap((r, i): DeliveryEvent[] => {
    const id = `${reportId}#${i}`;
    const detail = { ...r, subject: mail.subject };
    const error = `${r.status} ${r.diagnosticCode ?? ''}`.trim();
    switch (r.action) {
      case 'failed': {
        const policy = classifyPermanentFailure(r.status);
        return [{
          ...base, sourceEventId: id, type: policy.status === 'rejected' ? 'rejected' : 'bounced',
          status: policy.status, error, detail,
          suppress: policy.suppressAddress ? { scope: 'all', reason: 'hard_bounce', detail: error } : undefined,
        }];
      }
      case 'delayed':
        return [{ ...base, sourceEventId: id, type: 'deferred', status: 'mta_deferred', error, detail }];
      case 'delivered':
        // A final-delivery DSN is the only evidence we treat as "delivered".
        return [{ ...base, sourceEventId: id, type: 'delivered', status: 'delivered', detail }];
      default:
        return [{ ...base, sourceEventId: id, type: r.action, detail }];
    }
  });
}

export function complaintEvent(mail: Report, reportId: string, bounceSecret: string): DeliveryEvent | null {
  const report = partText(mail, ['message/feedback-report']);
  if (!report) return null;
  const fb = parseFeedbackReport(report);
  if (!fb || fb.feedbackType === 'not-spam') return null;
  const original = partText(mail, ['message/rfc822', 'text/rfc822-headers']);
  const headers = original ? originalHeaders(original) : {};
  // Trust the report only if it identifies one of our messages by its signed return path.
  const returnPath = headers['return-path'] ?? fb.originalMailFrom ?? '';
  const messageId = parseVerp(returnPath.replace(/^<|>$/g, ''), bounceSecret);
  if (!messageId) return null;
  return {
    messageId,
    source: 'arf',
    sourceEventId: reportId,
    type: 'complaint',
    suppress: { scope: 'topic', reason: 'complaint', detail: fb.feedbackType },
    detail: { feedbackType: fb.feedbackType },
  };
}
