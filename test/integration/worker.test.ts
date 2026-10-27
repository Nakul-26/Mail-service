import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, pool, status, verifyDomain, waitFor } from './helpers.js';

// Runs the real worker process against a local SMTP stub (no external servers):
//   bounce-me@ -> 550 5.1.1 at RCPT (permanent), defer-me@ -> 451 (temporary), anything else -> 250.

const received: { to: string; raw: string; mailFrom: string }[] = [];
let deferring = true;
const stub = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  onRcptTo(addr, _s, cb) {
    if (addr.address.startsWith('bounce-me')) return cb(Object.assign(new Error('5.1.1 no such user'), { responseCode: 550 }));
    if (addr.address.startsWith('defer-me') && deferring) return cb(Object.assign(new Error('4.2.0 try later'), { responseCode: 451 }));
    cb();
  },
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => {
      for (const r of session.envelope.rcptTo) received.push({ to: r.address, raw, mailFrom: (session.envelope.mailFrom as { address: string }).address });
      cb(null, 'Ok: queued as STUB' + received.length);
    });
  },
});

// Killing the worker mid-connection resets sockets; that is expected here.
stub.on('error', () => {});

let worker: ChildProcess | undefined;
const startWorker = () => {
  worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { env: process.env, stdio: 'ignore' });
};
const stopWorker = () => new Promise<void>((r) => (worker ? (worker.once('exit', () => r()), worker.kill('SIGTERM')) : r()));

let app: Awaited<ReturnType<typeof createApp>>;
const send = async (to: string, priority = 0) => {
  const { rows } = await pool.query(
    `INSERT INTO messages (app_id, template_id, from_addr, to_addr, variables, sensitive_keys, priority, max_attempts)
     VALUES ($1, 'exam-otp', 'exams@notify.test.example', $2, '{"name":"A","otp":"123456","expiresInMinutes":5}', '{otp}', $3, 3) RETURNING id`,
    [app.appId, to, priority],
  );
  return rows[0].id as string;
};

beforeAll(async () => {
  mkdirSync('./test/integration/.dkim', { recursive: true });
  // Other test files leave queued mail (e.g. a 10,000-recipient batch); these tests need an empty queue.
  await pool.query(`UPDATE messages SET status = 'cancelled' WHERE status IN ('queued', 'deferred', 'sending')`);
  await verifyDomain('notify.test.example');
  app = await createApp({ product: 'exam', from: 'exams@notify.test.example' });
  await new Promise<void>((r) => stub.listen(2599, '127.0.0.1', () => r()));
  startWorker();
});
afterAll(async () => {
  await stopWorker();
  await new Promise<void>((r) => stub.close(() => r()));
  rmSync('./test/integration/.dkim', { recursive: true, force: true });
});

describe('worker with an SMTP route', () => {
  it('hands mail over, records the next-hop id and removes secrets afterwards', async () => {
    const id = await send('ok@gmail.com');
    await waitFor(() => status(id), (s) => s === 'accepted_local');
    const { rows } = await pool.query('SELECT provider_message_id, variables FROM messages WHERE id = $1', [id]);
    expect(rows[0].provider_message_id).toMatch(/^STUB\d+$/);
    expect(rows[0].variables).not.toHaveProperty('otp');
    const mail = received.find((r) => r.to === 'ok@gmail.com')!;
    expect(mail.raw).toContain(`Message-ID: <${id}@notify.test.example>`);
    expect(mail.mailFrom).toMatch(/^bounce\+[0-9a-f]{32}-[0-9a-f]{12}@bounces\.test\.example$/);
  });

  it('fails permanent rejections at once and suppresses the address', async () => {
    const id = await send('bounce-me@gmail.com');
    await waitFor(() => status(id), (s) => s === 'failed');
    const { rows } = await pool.query('SELECT attempts FROM messages WHERE id = $1', [id]);
    expect(rows[0].attempts).toBe(1);
    const supp = await pool.query('SELECT reason FROM suppressions WHERE tenant_id = $1 AND email = $2', [app.tenantId, 'bounce-me@gmail.com']);
    expect(supp.rows[0].reason).toBe('hard_bounce');
  });

  it('retries temporary failures with backoff, then succeeds', async () => {
    const id = await send('defer-me@gmail.com');
    await waitFor(() => status(id), (s) => s === 'deferred');
    const { rows } = await pool.query('SELECT EXTRACT(EPOCH FROM next_attempt_at - now())::int AS wait FROM messages WHERE id = $1', [id]);
    expect(rows[0].wait).toBeGreaterThanOrEqual(10); // first retry after ~15-30 s, not immediately
    deferring = false;
    await pool.query('UPDATE messages SET next_attempt_at = now() WHERE id = $1', [id]); // skip the wait
    await waitFor(() => status(id), (s) => s === 'accepted_local');
  });

  it('recovers a message left mid-send by a crashed worker', async () => {
    await stopWorker();
    const id = await send('crash@gmail.com');
    // What a crash leaves behind: claimed, lease expired, never finished.
    await pool.query(`UPDATE messages SET status = 'sending', attempts = 1, locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    startWorker();
    await waitFor(() => status(id), (s) => s === 'accepted_local');
  });

  it('sends OTPs before a large backlog of bulk mail', async () => {
    await stopWorker();
    const bulk = [];
    for (let i = 0; i < 200; i++) bulk.push(await send(`bulk${i}@college.test.example`, 2));
    const otp = await send('urgent@gmail.com', 0);
    const before = received.length;
    startWorker();
    await waitFor(() => status(otp), (s) => s === 'accepted_local');
    const position = received.slice(before).findIndex((r) => r.to === 'urgent@gmail.com');
    expect(position).toBeLessThan(10); // first claim cycle, not behind the 200 bulk messages
    await waitFor(async () => (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE id = ANY($1) AND status = 'accepted_local'`, [bulk])).rows[0].n, (n) => n === 200, 30_000);
  });
});

