import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createApp, pool, verifyDomain } from './helpers.js';

const app = buildApp({ logger: false });
const instructions = { examName: 'DBMS Midterm', startsAt: '10:00 IST', examUrl: 'https://exams.example.com/x' };
let exam: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  await verifyDomain('notify.test.example');
  exam = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
});
afterAll(async () => {
  await app.close();
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/batches', headers: { ...exam.auth, ...headers }, payload: payload as object });

describe('POST /v1/batches', () => {
  it('accepts 10,000 recipients, de-duplicates them and stores them in the bulk lane', async () => {
    const recipients = Array.from({ length: 10_000 }, (_, i) => ({ to: `student${i}@college.test.example`, variables: { name: `S${i}` } }));
    recipients.push({ to: 'STUDENT1@college.test.example', variables: { name: 'dup' } });
    const started = Date.now();
    const res = await post({ template: 'exam-instructions', variables: instructions, recipients: recipients.slice(0, 10_000) });
    expect(res.statusCode, res.body).toBe(202);
    const elapsed = Date.now() - started;
    const body = res.json();
    expect(body).toMatchObject({ state: 'accepted', recipients: 10_000, duplicatesRemoved: 0 });
    const { rows } = await pool.query('SELECT count(*)::int AS n, min(priority) AS p FROM messages WHERE batch_id = $1', [body.id]);
    expect(rows[0]).toEqual({ n: 10_000, p: 2 });
    console.log(`10,000-recipient batch accepted in ${elapsed} ms`);
  });

  it('removes duplicate recipients (case-insensitive)', async () => {
    const res = await post({
      template: 'exam-instructions',
      variables: instructions,
      recipients: [{ to: 'a@x.test.example', variables: { name: 'A' } }, { to: 'A@X.test.example', variables: { name: 'A2' } }],
    });
    expect(res.json()).toMatchObject({ recipients: 1, duplicatesRemoved: 1 });
  });

  it('rejects the whole batch when any recipient is invalid, saying which', async () => {
    const res = await post({
      template: 'exam-instructions',
      variables: instructions,
      recipients: [{ to: 'ok@x.test.example', variables: { name: 'A' } }, { to: 'broken', variables: { name: 'B' } }, { to: 'c@x.test.example' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().invalidCount).toBe(2);
    expect(res.json().details.map((d: { index: number }) => d.index)).toEqual([1, 2]);
  });

  it('refuses OTP templates, oversize batches and batches over the daily quota', async () => {
    expect((await post({ template: 'exam-otp', recipients: [{ to: 'a@x.test.example' }] })).json().error).toBe('template_not_allowed_in_batch');
    const small = await createApp({ product: 'exam', from: 'exams@notify.test.example', maxBatchSize: 2, dailyQuota: 3 });
    const r = (n: number) => Array.from({ length: n }, (_, i) => ({ to: `q${i}@x.test.example`, variables: { name: 'Q' } }));
    const tooBig = await app.inject({ method: 'POST', url: '/v1/batches', headers: small.auth, payload: { template: 'exam-instructions', variables: instructions, recipients: r(3) } });
    expect(tooBig.json()).toMatchObject({ error: 'batch_too_large', max: 2 });
    await app.inject({ method: 'POST', url: '/v1/batches', headers: small.auth, payload: { template: 'exam-instructions', variables: instructions, recipients: r(2) } });
    const overQuota = await app.inject({ method: 'POST', url: '/v1/batches', headers: small.auth, payload: { template: 'exam-instructions', variables: instructions, recipients: r(2) } });
    expect(overQuota.statusCode).toBe(429);
  });

  it('is idempotent', async () => {
    const payload = { template: 'exam-instructions', variables: instructions, recipients: [{ to: 'idem@x.test.example', variables: { name: 'I' } }] };
    const a = await post(payload, { 'idempotency-key': 'exam-42-announcement' });
    const b = await post(payload, { 'idempotency-key': 'exam-42-announcement' });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, duplicate: true });
  });

  it('stores suppressed recipients as suppressed instead of sending to them', async () => {
    await pool.query(`INSERT INTO suppressions (tenant_id, email, reason) VALUES ($1, 'gone@x.test.example', 'hard_bounce')`, [exam.tenantId]);
    const res = await post({
      template: 'exam-instructions',
      variables: instructions,
      recipients: [{ to: 'gone@x.test.example', variables: { name: 'G' } }, { to: 'here@x.test.example', variables: { name: 'H' } }],
    });
    expect(res.json()).toMatchObject({ recipients: 2, suppressed: 1 });
  });
});

describe('batch status, results and cancellation', () => {
  it('reports progress, lists per-recipient results and cancels pending work', async () => {
    const recipients = Array.from({ length: 5 }, (_, i) => ({ to: `c${i}@x.test.example`, variables: { name: 'C' } }));
    const id = (await post({ template: 'exam-instructions', variables: instructions, recipients })).json().id;
    // Pretend the worker already handed two to Postfix.
    await pool.query(`UPDATE messages SET status = 'accepted_local' WHERE id IN (SELECT id FROM messages WHERE batch_id = $1 ORDER BY id LIMIT 2)`, [id]);

    const status = (await app.inject({ method: 'GET', url: `/v1/batches/${id}`, headers: exam.auth })).json();
    expect(status).toMatchObject({ state: 'sending', progress: { pending: 3, atMta: 2, final: 0 } });

    const page1 = (await app.inject({ method: 'GET', url: `/v1/batches/${id}/recipients?limit=3`, headers: exam.auth })).json();
    expect(page1.recipients).toHaveLength(3);
    const page2 = (await app.inject({ method: 'GET', url: `/v1/batches/${id}/recipients?limit=3&after=${page1.next}`, headers: exam.auth })).json();
    expect(page2.recipients).toHaveLength(2);

    const cancelled = (await app.inject({ method: 'POST', url: `/v1/batches/${id}/cancel`, headers: exam.auth })).json();
    expect(cancelled).toMatchObject({ cancelledNow: 3, state: 'awaiting_mta', counts: { cancelled: 3, accepted_local: 2 } });
  });

  it("can't be read or cancelled by another app", async () => {
    const id = (await post({ template: 'exam-instructions', variables: instructions, recipients: [{ to: 'o@x.test.example', variables: { name: 'O' } }] })).json().id;
    const other = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
    expect((await app.inject({ method: 'GET', url: `/v1/batches/${id}`, headers: other.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/batches/${id}/cancel`, headers: other.auth })).statusCode).toBe(404);
    const { rows } = await pool.query('SELECT status::text FROM messages WHERE batch_id = $1', [id]);
    expect(rows[0].status).toBe('queued');
  });
});
