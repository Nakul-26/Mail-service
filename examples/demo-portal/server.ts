// A tiny "exam portal" that uses the mail service the way a real product would:
//   - OTP login (POST /v1/emails with the exam-otp template, Idempotency-Key per attempt)
//   - an exam announcement to many dummy candidates (POST /v1/batches)
//   - status lookups (GET /v1/emails/:id, GET /v1/batches/:id)
// The API key stays on this server; the browser only talks to this server.
//
//   npx tsx examples/demo-portal/server.ts      (reads examples/demo-portal/.env)
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(here, '.env'));
} catch {
  // fine: settings may come from the environment
}
const API = (process.env.MAIL_API_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const KEY = process.env.MAIL_API_KEY;
const PORT = Number(process.env.PORT ?? 4000);
if (!KEY) throw new Error('MAIL_API_KEY is not set (see examples/demo-portal/README.md)');

const OTP_MINUTES = 10;
const MAX_TRIES = 5;
// email -> pending login. In memory: a real portal would keep this in its own database.
const pending = new Map<string, { hash: Buffer; expires: number; tries: number; attempt: number }>();
const sha = (s: string) => createHash('sha256').update(s).digest();

async function mail(method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const routes: Record<string, (body: any, url: URL) => Promise<[number, unknown]>> = {
  'POST /api/otp/send': async ({ email, name }) => {
    email = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return [400, { error: 'enter a valid email' }];
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const attempt = (pending.get(email)?.attempt ?? 0) + 1;
    pending.set(email, { hash: sha(otp), expires: Date.now() + OTP_MINUTES * 60_000, tries: 0, attempt });
    const r = await mail(
      'POST',
      '/v1/emails',
      { to: email, template: 'exam-otp', variables: { name: name || 'Candidate', otp, expiresInMinutes: OTP_MINUTES } },
      `demo-otp-${email}-${attempt}-${Date.now()}`,
    );
    if (r.status !== 202) return [502, { error: 'mail service refused the OTP', detail: r.body }];
    return [200, { messageId: r.body.id, status: r.body.status }];
  },

  'POST /api/otp/verify': async ({ email, otp }) => {
    email = String(email ?? '').trim().toLowerCase();
    const p = pending.get(email);
    if (!p || p.expires < Date.now()) return [400, { ok: false, error: 'no valid code; request a new one' }];
    if (++p.tries > MAX_TRIES) {
      pending.delete(email);
      return [429, { ok: false, error: 'too many attempts; request a new code' }];
    }
    const ok = timingSafeEqual(p.hash, sha(String(otp ?? '').trim()));
    if (ok) pending.delete(email);
    return [ok ? 200 : 400, ok ? { ok: true } : { ok: false, error: 'wrong code' }];
  },

  'POST /api/announce': async ({ count, examName }) => {
    const n = Math.max(1, Math.min(10_000, Number(count) || 50));
    // Dummy candidates. In development every address lands in Mailpit, so nothing leaves the machine.
    const recipients = Array.from({ length: n }, (_, i) => {
      const id = String(i + 1).padStart(5, '0');
      return { to: `candidate${id}@students.demo.test`, variables: { name: `Candidate ${id}` } };
    });
    const r = await mail(
      'POST',
      '/v1/batches',
      {
        template: 'exam-instructions',
        variables: { examName: examName || 'Demo Exam', startsAt: 'Monday 10:00', examUrl: `http://127.0.0.1:${PORT}/` },
        recipients,
      },
      `demo-batch-${Date.now()}`,
    );
    return [r.status === 202 ? 200 : 502, r.body];
  },

  'GET /api/email': async (_b, url) => {
    const r = await mail('GET', `/v1/emails/${encodeURIComponent(url.searchParams.get('id') ?? '')}`);
    return [r.status, r.body];
  },
  'GET /api/batch': async (_b, url) => {
    const r = await mail('GET', `/v1/batches/${encodeURIComponent(url.searchParams.get('id') ?? '')}`);
    return [r.status, r.body];
  },
  'GET /api/usage': async () => {
    const r = await mail('GET', '/v1/usage');
    return [r.status, r.body];
  },
};

async function readJson(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const page = readFileSync(join(here, 'index.html'), 'utf8');

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  try {
    const [status, body] = await handler(req.method === 'POST' ? await readJson(req) : {}, url);
    send(res, status, body);
  } catch (err) {
    send(res, 502, { error: 'mail service unreachable', detail: (err as Error).message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`demo portal on http://127.0.0.1:${PORT} -> mail service ${API}`);
});
