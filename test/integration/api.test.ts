import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createApp, pool, verifyDomain } from './helpers.js';

const app = buildApp({ logger: false });
const otp = (to: string, extra: Record<string, unknown> = {}) => ({
  to,
  template: 'exam-otp',
  variables: { name: 'Asha', otp: '482913', expiresInMinutes: 10 },
  ...extra,
});

let exam: Awaited<ReturnType<typeof createApp>>;
let placement: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  await verifyDomain('notify.test.example');
  exam = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
  placement = await createApp({ product: 'placement', from: 'placements@notify.test.example' });
});
afterAll(async () => {
  await app.close();
});

describe('authentication', () => {
  it('rejects missing, malformed and unknown keys', async () => {
    for (const authorization of [undefined, 'Bearer nope', 'Bearer elm_000000000000_xxxxxxxx']) {
      const res = await app.inject({ method: 'GET', url: '/v1/templates', headers: authorization ? { authorization } : {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it('stops accepting a key as soon as it is revoked', async () => {
    const a = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
    expect((await app.inject({ method: 'GET', url: '/v1/templates', headers: a.auth })).statusCode).toBe(200);
    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE prefix = $1', [a.prefix]);
    expect((await app.inject({ method: 'GET', url: '/v1/templates', headers: a.auth })).statusCode).toBe(401);
  });
});

describe('tenant isolation', () => {
  it("one app cannot read another app's messages", async () => {
    const sent = await app.inject({ method: 'POST', url: '/v1/emails', headers: exam.auth, payload: otp('iso@gmail.com') });
    expect(sent.statusCode).toBe(202);
    const id = sent.json().id;
    expect((await app.inject({ method: 'GET', url: `/v1/emails/${id}`, headers: exam.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/emails/${id}`, headers: placement.auth })).statusCode).toBe(404);
  });

  it('only lists and accepts templates of the app\'s own product', async () => {
    const list = (await app.inject({ method: 'GET', url: '/v1/templates', headers: placement.auth })).json();
    expect(list.map((t: { id: string }) => t.id)).not.toContain('exam-otp');
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: placement.auth, payload: otp('x@gmail.com') });
    expect(res.statusCode).toBe(404);
  });

  it('reports usage for the calling app only', async () => {
    const usage = (await app.inject({ method: 'GET', url: '/v1/usage', headers: placement.auth })).json();
    expect(usage.total).toBe(0);
  });

  it('keeps idempotency keys per app', async () => {
    const key = { 'idempotency-key': 'shared-key-1' };
    const a = await app.inject({ method: 'POST', url: '/v1/emails', headers: { ...exam.auth, ...key }, payload: otp('k@gmail.com') });
    const other = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
    const b = await app.inject({ method: 'POST', url: '/v1/emails', headers: { ...other.auth, ...key }, payload: otp('k@gmail.com') });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json().id).not.toBe(a.json().id);
  });
});

describe('senders', () => {
  it('refuses senders the app is not allowed to use', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: exam.auth, payload: otp('a@gmail.com', { from: 'ceo@notify.test.example' }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('sender_not_allowed');
  });

  it('refuses sender domains that have not been verified', async () => {
    const a = await createApp({ product: 'exam', from: 'exams@unverified.test.example' });
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: a.auth, payload: otp('a@gmail.com') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('sender_domain_not_verified');
  });
});

describe('idempotency', () => {
  it('returns the original message for a repeated request', async () => {
    const headers = { ...exam.auth, 'idempotency-key': 'otp-attempt-77' };
    const first = await app.inject({ method: 'POST', url: '/v1/emails', headers, payload: otp('idem@gmail.com') });
    const again = await app.inject({ method: 'POST', url: '/v1/emails', headers, payload: otp('idem@gmail.com') });
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, duplicate: true });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages WHERE idempotency_key = $1', ['otp-attempt-77']);
    expect(rows[0].n).toBe(1);
  });
});

describe('malformed and abusive requests', () => {
  it('rejects bad JSON, bad addresses, unknown variables and header tricks in addresses', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v1/emails', headers: { ...exam.auth, 'content-type': 'application/json' }, payload: '{"to":' });
    expect(bad.statusCode).toBe(400);
    for (const to of ['not-an-email', 'a@gmail.com\r\nBcc: victim@x.com', 'a@gmail.com, b@gmail.com']) {
      const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: exam.auth, payload: otp(to) });
      expect(res.statusCode, to).toBe(400);
    }
    const extra = await app.inject({ method: 'POST', url: '/v1/emails', headers: exam.auth, payload: { ...otp('a@gmail.com'), variables: { name: 'A', otp: '1', expiresInMinutes: 5, html: '<script>' } } });
    expect(extra.statusCode).toBe(422);
  });

  it('rejects oversized bodies', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: exam.auth, payload: { ...otp('a@gmail.com'), pad: 'x'.repeat(300_000) } });
    expect(res.statusCode).toBe(413);
  });

  it('enforces the daily quota', async () => {
    const a = await createApp({ product: 'exam', from: 'exams@notify.test.example', dailyQuota: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/emails', headers: a.auth, payload: otp(`q${i}@gmail.com`) })).statusCode);
    expect(codes).toEqual([202, 202, 429]);
  });

  it('keeps /metrics closed without the token and the SES webhook off when not configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics', remoteAddress: '203.0.113.9' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/webhooks/ses', payload: { Type: 'Notification' } })).statusCode).toBe(404);
  });
});
