import { generateKeyPairSync } from 'node:crypto';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { composeMail, type Composed, type ComposeJob } from '../src/compose.js';
import { templates } from '../src/templates.js';
import { parseVerp } from '../src/verp.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dkim = {
  domainName: 'notify.example.com',
  keySelector: 's2026',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
// Stands in for DNS: the TXT record `npm run domain -- add` tells you to publish.
const resolver = async (name: string, type: string) => {
  if (type === 'TXT' && name === 's2026._domainkey.notify.example.com') return [[`v=DKIM1; k=rsa; p=${publicB64}`]];
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
};

const BOUNCE_SECRET = 'b'.repeat(40);
const job: ComposeJob = {
  id: '6f1c2b3a-1111-4222-8333-944445555666',
  tenant_id: 't1',
  from_addr: 'exams@notify.example.com',
  to_addr: 'asha@gmail.com',
  variables: { name: 'Asha', otp: '482913', expiresInMinutes: 10 },
  category: 'transactional',
  topic: null,
};
const postfix = { kind: 'postfix' as const, verpDomain: 'bounces.example.com', requireDkim: true };
const opts = { publicBaseUrl: 'https://mail.example.com', unsubscribeSecret: 'u'.repeat(40), bounceSecret: BOUNCE_SECRET, dkim };

function mailOf(c: Composed): SendMailOptions {
  if (!c.ok) throw new Error(c.error);
  return c.mail;
}

async function build(mail: SendMailOptions) {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await t.sendMail(mail);
  return { raw: info.message as Buffer, envelope: info.envelope };
}

describe('composeMail for the postfix route', () => {
  it('signs with DKIM so the signature verifies against the published key', async () => {
    const { raw } = await build(mailOf(composeMail(job, postfix, templates.get('exam-otp')!, opts)));
    const result = await dkimVerify(raw, { resolver });
    expect(result.results[0]).toMatchObject({ status: { result: 'pass' }, signingDomain: 'notify.example.com' });
  });

  it('uses a signed VERP return path and our id as Message-ID', async () => {
    const { raw, envelope } = await build(mailOf(composeMail(job, postfix, templates.get('exam-otp')!, opts)));
    expect(parseVerp(envelope.from as string, BOUNCE_SECRET)).toBe(job.id);
    expect(raw.toString()).toContain(`Message-ID: <${job.id}@notify.example.com>`);
    expect(raw.toString()).not.toMatch(/X-SES-/i);
  });

  it('refuses to send unsigned mail on a postfix route', () => {
    const c = composeMail(job, postfix, templates.get('exam-otp')!, { ...opts, dkim: null });
    expect(c).toMatchObject({ ok: false, error: expect.stringContaining('no DKIM key for notify.example.com') });
  });

  it('cannot be tricked into adding headers through template variables', async () => {
    const evil = {
      ...job,
      variables: { name: 'A', examName: 'Maths\r\nBcc: victim@evil.com', startsAt: '10:00', examUrl: 'https://x' },
    };
    const { raw, envelope } = await build(mailOf(composeMail(evil, postfix, templates.get('exam-instructions')!, opts)));
    const head = raw.toString().split('\n\n')[0]!;
    expect(head).not.toMatch(/^Bcc:/im);
    expect(envelope.to).toEqual(['asha@gmail.com']);
  });

  it('adds one-click unsubscribe headers to marketing mail', async () => {
    const news = {
      ...job,
      category: 'marketing' as const,
      topic: 'alumni-newsletter',
      variables: { name: 'P', title: 'T', message: 'M' },
    };
    const { raw } = await build(mailOf(composeMail(news, postfix, templates.get('alumni-newsletter')!, opts)));
    const head = raw.toString().split('\n\n')[0]!.replace(/\n[ \t]+/g, ' '); // unfold long headers
    expect(head).toMatch(/^List-Unsubscribe: <https:\/\/mail\.example\.com\/u\/[^>]+>$/m);
    expect(head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect((await dkimVerify(raw, { resolver })).results[0]).toMatchObject({ status: { result: 'pass' } });
  });
});
