import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBounceReceiver } from '../../src/bounce-receiver.js';
import { recordEvent } from '../../src/events.js';
import { applyPending, ingest } from '../../src/log-tracker.js';
import { verpAddress } from '../../src/verp.js';
import { createApp, pool, status } from './helpers.js';

const BOUNCE_SECRET = process.env.BOUNCE_SECRET!;
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
});

async function message(statusValue = 'accepted_local', to = `${randomUUID().slice(0, 8)}@gmail.com`) {
  const { rows } = await pool.query(
    `INSERT INTO messages (app_id, template_id, from_addr, to_addr, variables, priority, status, max_attempts, sent_at)
     VALUES ($1, 'exam-otp', 'exams@notify.test.example', $2, '{}', 0, $3, 8, now()) RETURNING id`,
    [app.appId, to, statusValue],
  );
  return { id: rows[0].id as string, to };
}

const ev = (messageId: string, sourceEventId: string, extra: object) =>
  ({ messageId, source: 'postfix-log', sourceEventId, type: 't', detail: {}, ...extra }) as Parameters<typeof recordEvent>[0];

describe('status transitions', () => {
  it('only move forward, ignore replays, and wait while the hand-off is in flight', async () => {
    const m = await message('sending');
    expect(await recordEvent(ev(m.id, 'a', { status: 'accepted_remote' }))).toBe('not_ready');
    await pool.query(`UPDATE messages SET status = 'accepted_local' WHERE id = $1`, [m.id]);

    expect(await recordEvent(ev(m.id, 'a', { status: 'accepted_remote' }))).toBe('applied');
    expect(await recordEvent(ev(m.id, 'a', { status: 'accepted_remote' }))).toBe('duplicate');
    expect(await recordEvent(ev(m.id, 'b', { status: 'mta_deferred' }))).toBe('applied');
    expect(await status(m.id)).toBe('accepted_remote'); // a late "deferred" doesn't undo acceptance
    expect(await recordEvent(ev(m.id, 'c', { status: 'bounced' }))).toBe('applied'); // async bounce after acceptance
    expect(await recordEvent(ev(m.id, 'd', { status: 'accepted_remote' }))).toBe('applied');
    expect(await status(m.id)).toBe('bounced'); // final stays final
  });
});

describe('Postfix log tracker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maillog-'));
  const file = join(dir, 'maillog');

  it('maps queue ids, applies outcomes, survives restarts and log rotation', async () => {
    await pool.query('DELETE FROM tracker_state');
    const ok = await message();
    const bad = await message();
    const deferred = await message();
    const line = (qid: string, rest: string) => `Oct 27 10:00:00 mail postfix/${rest.startsWith('message-id') ? 'cleanup' : 'smtp'}[1]: ${qid}: ${rest}\n`;
    writeFileSync(
      file,
      line('QOK0000001', `message-id=<${ok.id}@notify.test.example>`) +
        line('QBAD000001', `message-id=<${bad.id}@notify.test.example>`) +
        line('QDEF000001', `message-id=<${deferred.id}@notify.test.example>`) +
        line('QOK0000001', `to=<${ok.to}>, relay=mx.gmail.test[1.2.3.4]:25, delay=1, dsn=2.0.0, status=sent (250 2.0.0 OK)`) +
        line('QBAD000001', `to=<${bad.to}>, relay=mx.gmail.test[1.2.3.4]:25, delay=1, dsn=5.1.1, status=bounced (550 5.1.1 no such user (in reply to RCPT TO command))`) +
        // a partly written line must not be consumed yet
        `Oct 27 10:00:01 mail postfix/smtp[1]: QDEF000001: to=<${deferred.to}>, relay=none, delay=30, dsn=4.4.1, status=defer`,
    );
    await ingest(file);
    await applyPending();
    expect(await status(ok.id)).toBe('accepted_remote');
    expect(await status(bad.id)).toBe('bounced');
    expect(await status(deferred.id)).toBe('accepted_local');
    const supp = await pool.query('SELECT reason FROM suppressions WHERE tenant_id = $1 AND email = $2', [app.tenantId, bad.to]);
    expect(supp.rows[0]?.reason).toBe('hard_bounce');

    // The rest of the partial line arrives; then the log is rotated and a new file starts.
    appendFileSync(file, 'red (connect to mx: Connection timed out)\n');
    renameSync(file, `${file}.20261027`);
    writeFileSync(file, '');
    // "Restart": re-read everything from the saved offsets. Nothing applies twice.
    await ingest(file);
    await ingest(file);
    await applyPending();
    expect(await status(deferred.id)).toBe('mta_deferred');
    const events = await pool.query('SELECT count(*)::int AS n FROM message_events WHERE message_id = ANY($1)', [[ok.id, bad.id, deferred.id]]);
    expect(events.rows[0].n).toBe(3);
    expect(readFileSync(`${file}.20261027`, 'utf8')).toContain('status=deferred');
  });
});

describe('bounce receiver (real SMTP)', () => {
  let server: SMTPServer;
  const port = 2598;
  const send = (to: string, raw: string) =>
    nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }).sendMail({ envelope: { from: '', to }, raw });

  beforeAll(async () => {
    server = createBounceReceiver(BOUNCE_SECRET, { info: () => {}, error: () => {} } as unknown as Console);
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('applies a DSN sent to a valid VERP address', async () => {
    const m = await message('accepted_remote');
    const verp = verpAddress(m.id, 'bounces.test.example', BOUNCE_SECRET);
    const raw = readFileSync(new URL('../fixtures/postfix-bounce.eml', import.meta.url), 'utf8').replaceAll('VERP_ADDRESS', verp);
    await send(verp, raw);
    expect(await status(m.id)).toBe('bounced');
    const supp = await pool.query('SELECT 1 FROM suppressions WHERE tenant_id = $1 AND email = $2', [app.tenantId, m.to]);
    expect(supp.rowCount).toBe(1);
  });

  it('refuses mail for forged or unknown addresses, so it cannot be used to suppress people', async () => {
    const m = await message('accepted_remote');
    const forged = verpAddress(m.id, 'bounces.test.example', 'wrong-secret-wrong-secret-wrong-secret!!');
    await expect(send(forged, 'Subject: x\r\n\r\nx')).rejects.toThrow(/550/);
    await expect(send('postmaster@bounces.test.example', 'Subject: x\r\n\r\nx')).rejects.toThrow(/550/);
    expect(await status(m.id)).toBe('accepted_remote');
  });
});
