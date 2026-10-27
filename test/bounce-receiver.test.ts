import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { complaintEvent, dsnEvents } from '../src/bounce-receiver.js';
import { parseDeliveryStatus, parseReport } from '../src/dsn.js';
import { verpAddress } from '../src/verp.js';

const SECRET = 'x'.repeat(40);
const ID = '6f1c2b3a-1111-4222-8333-944445555666';
const VERP = verpAddress(ID, 'bounces.example.com', SECRET);
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replaceAll('VERP_ADDRESS', VERP);

describe('DSN parsing', () => {
  it('reads a Postfix bounce notice', async () => {
    const mail = parseReport(fixture('postfix-bounce.eml'));
    const events = dsnEvents(mail, ID, 'sha256:abc');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      messageId: ID,
      source: 'dsn',
      type: 'bounced',
      status: 'bounced',
      suppress: { scope: 'all', reason: 'hard_bounce' },
    });
    expect(events[0]!.error).toContain('5.1.1');
  });

  it('handles delayed and delivered actions', () => {
    const body =
      'Reporting-MTA: dns; mx.example\n\n' +
      'Final-Recipient: rfc822; a@b.c\nAction: delayed\nStatus: 4.4.7\n\n' +
      'Final-Recipient: rfc822; d@e.f\nAction: delivered\nStatus: 2.0.0\n';
    expect(parseDeliveryStatus(body).map((r) => [r.finalRecipient, r.action, r.status])).toEqual([
      ['a@b.c', 'delayed', '4.4.7'],
      ['d@e.f', 'delivered', '2.0.0'],
    ]);
  });

  it('ignores mail that is not a DSN, such as an auto-reply', async () => {
    const mail = parseReport('From: a@b.c\nTo: x@y.z\nSubject: Out of office\n\nI am away.\n');
    expect(dsnEvents(mail, ID, 'sha256:abc')).toEqual([]);
  });
});

describe('complaint (ARF) reports', () => {
  it('suppress the topic when the report carries our signed return path', async () => {
    const mail = parseReport(fixture('arf-complaint.eml'));
    expect(complaintEvent(mail, 'sha256:def', SECRET)).toMatchObject({
      messageId: ID,
      source: 'arf',
      type: 'complaint',
      suppress: { scope: 'topic', reason: 'complaint' },
    });
  });

  it('are ignored when the original message cannot be authenticated', async () => {
    const forgedPath = 'bounce+6f1c2b3a111142228333944445555666-000000000000@bounces.example.com';
    const forged = fixture('arf-complaint.eml').replaceAll(VERP, forgedPath);
    expect(complaintEvent(parseReport(forged), 'sha256:x', SECRET)).toBeNull();
  });
});
