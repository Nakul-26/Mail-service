import { describe, expect, it } from 'vitest';
import { classifyPermanentFailure } from '../src/events.js';
import { logEventToDeliveryEvent } from '../src/log-tracker.js';
import { parsePostfixLine } from '../src/postfix-log.js';

const ID = '6f1c2b3a-1111-4222-8333-944445555666';

// Shapes as Postfix 3.x writes them with maillog_file (timestamp formats vary; the parser ignores them).
const lines = {
  cleanup: `2026-10-27T10:00:00.123456+00:00 mail postfix/cleanup[211]: 4ZqK1x2y3zz1Nk: message-id=<${ID}@notify.example.com>`,
  sent: 'Oct 27 10:00:01 mail postfix/smtp[212]: 4ZqK1x2y3zz1Nk: to=<Asha@Gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.4.27]:25, delay=1.1, delays=0.1/0/0.5/0.5, dsn=2.0.0, status=sent (250 2.0.0 OK  1761559201 af79cd13be357-8a3b; - gsmtp)',
  deferred: 'Oct 27 10:00:02 mail postfix/smtp[212]: 4ZqK1x2y3zz1Nk: to=<a@outlook.com>, relay=none, delay=30, delays=0/0/30/0, dsn=4.4.1, status=deferred (connect to outlook-com.olc.protection.outlook.com[52.101.1.1]:25: Connection timed out)',
  bounced: 'Oct 27 10:00:03 mail postfix/smtp[212]: 4ZqK1x2y3zz1Nk: to=<nosuch@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.4.27]:25, delay=0.9, delays=0.1/0/0.4/0.4, dsn=5.1.1, status=bounced (host gmail-smtp-in.l.google.com[142.250.4.27] said: 550-5.1.1 The email account that you tried to reach does not exist. (in reply to RCPT TO command))',
  rejected: 'Oct 27 10:00:04 mail postfix/smtp[212]: 4ZqK1x2y3zz1Nk: to=<a@gmail.com>, relay=gmail-smtp-in.l.google.com[142.250.4.27]:25, delay=0.9, delays=0.1/0/0.4/0.4, dsn=5.7.26, status=bounced (host said: 550-5.7.26 Unauthenticated email is not accepted (in reply to end of DATA command))',
  expired: 'Oct 28 10:00:00 mail postfix/qmgr[90]: 4ZqK1x2y3zz1Nk: from=<bounce+abc@bounces.example.com>, status=expired, returned to sender',
};

describe('parsePostfixLine', () => {
  it('maps queue ids to our message ids', () => {
    expect(parsePostfixLine(lines.cleanup)).toEqual({ kind: 'message-id', queueId: '4ZqK1x2y3zz1Nk', messageId: ID });
  });

  it('ignores Message-IDs that are not ours and unrelated lines', () => {
    expect(parsePostfixLine('Oct 27 mail postfix/cleanup[1]: 4ZqK1x2y3zz1Nk: message-id=<20261027.ABC@mail.example.com>')).toBeNull();
    expect(parsePostfixLine('Oct 27 mail postfix/qmgr[1]: 4ZqK1x2y3zz1Nk: removed')).toBeNull();
    expect(parsePostfixLine('Oct 27 mail postfix/smtpd[1]: connect from worker[172.29.0.5]')).toBeNull();
  });

  it('parses sent, deferred and bounced deliveries', () => {
    expect(parsePostfixLine(lines.sent)).toMatchObject({
      kind: 'delivery', to: 'asha@gmail.com', status: 'sent', dsn: '2.0.0',
      relay: 'gmail-smtp-in.l.google.com[142.250.4.27]:25',
    });
    expect(parsePostfixLine(lines.deferred)).toMatchObject({ status: 'deferred', dsn: '4.4.1', relay: 'none' });
    expect(parsePostfixLine(lines.bounced)).toMatchObject({ status: 'bounced', dsn: '5.1.1' });
    expect(parsePostfixLine(lines.expired)).toEqual({ kind: 'expired', queueId: '4ZqK1x2y3zz1Nk' });
  });
});

describe('postfix log events -> message state', () => {
  const ev = (line: string) => logEventToDeliveryEvent(parsePostfixLine(line)!, ID, 'f@1');

  it('treats status=sent as accepted by the remote server, not delivered', () => {
    expect(ev(lines.sent)).toMatchObject({ status: 'accepted_remote' });
  });

  it('marks deferrals as MTA-deferred so the worker does not resend', () => {
    expect(ev(lines.deferred)).toMatchObject({ status: 'mta_deferred' });
  });

  it('suppresses unknown addresses but not policy rejections', () => {
    expect(ev(lines.bounced)).toMatchObject({ status: 'bounced', suppress: { scope: 'all', reason: 'hard_bounce' } });
    const rejected = ev(lines.rejected);
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(rejected.suppress).toBeUndefined();
  });

  it('fails expired messages', () => {
    expect(ev(lines.expired)).toMatchObject({ status: 'failed' });
  });
});

describe('classifyPermanentFailure', () => {
  it('distinguishes bad addresses, policy rejections and other bounces', () => {
    expect(classifyPermanentFailure('5.1.1')).toEqual({ status: 'bounced', suppressAddress: true });
    expect(classifyPermanentFailure('5.2.1')).toEqual({ status: 'bounced', suppressAddress: true });
    expect(classifyPermanentFailure('5.7.1')).toEqual({ status: 'rejected', suppressAddress: false });
    expect(classifyPermanentFailure('5.2.2')).toEqual({ status: 'bounced', suppressAddress: false }); // mailbox full
    expect(classifyPermanentFailure(undefined)).toEqual({ status: 'bounced', suppressAddress: false });
  });
});
