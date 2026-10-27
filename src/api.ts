import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AppContext } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import { isRecipientAllowed } from './recipients.js';
import { applySesEvent, type SesEvent } from './ses-events.js';
import { isSnsUrl, verifySnsMessage } from './sns.js';
import { findSuppression } from './suppressions.js';
import { templates, validateVariables } from './templates.js';
import { verifyUnsubscribe } from './unsubscribe.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller: AppContext;
  }
}

const app = Fastify({
  logger: { redact: ['req.headers.authorization'] },
  bodyLimit: 256 * 1024,
  // Unsubscribe tokens are ~170 chars; Fastify's default limit is 100.
  maxParamLength: 512,
});

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/v1/')) return;
  const ctx = await authenticate(req.headers.authorization);
  if (!ctx) return reply.code(401).send({ error: 'invalid_api_key' });
  req.caller = ctx;
});

app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch {
    return reply.code(503).send({ status: 'database_unavailable' });
  }
});

const sendSchema = z.object({
  to: z.string().email().max(254),
  template: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({}),
  from: z.string().email().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

app.post('/v1/emails', async (req, reply) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
  }
  const body = parsed.data;
  const ctx = req.caller;
  const idempotencyKey = body.idempotencyKey ?? headerValue(req, 'idempotency-key');

  const template = templates.get(body.template);
  if (!template || !template.meta.products.includes(ctx.product)) {
    return reply.code(404).send({ error: 'template_not_found' });
  }

  const from = (body.from ?? ctx.defaultFrom).toLowerCase();
  if (!ctx.allowedSenders.map((s) => s.toLowerCase()).includes(from)) {
    return reply.code(403).send({ error: 'sender_not_allowed', from });
  }

  if (!isRecipientAllowed(body.to, ctx.allowedRecipients)) {
    return reply.code(403).send({ error: 'recipient_not_allowed', to: body.to });
  }

  const problems = validateVariables(template, body.variables);
  if (problems.length) return reply.code(422).send({ error: 'invalid_variables', details: problems });

  // Repeat of an earlier request: return the original message, don't count against quota.
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(ctx.appId, idempotencyKey);
    if (existing) return reply.code(200).send(existing);
  }

  const limited = await checkLimits(ctx);
  if (limited) return reply.code(429).send({ error: limited });

  const to = body.to.toLowerCase();
  const topic = template.meta.topic ?? null;
  const suppressionReason = await findSuppression(pool, ctx.tenantId, to, topic);

  const { rows } = await pool.query(
    `INSERT INTO messages (app_id, idempotency_key, template_id, from_addr, to_addr, variables,
                           sensitive_keys, priority, status, max_attempts, category, topic)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (app_id, idempotency_key) DO NOTHING
     RETURNING id, status, created_at`,
    [
      ctx.appId,
      idempotencyKey ?? null,
      template.id,
      from,
      to,
      // A suppressed message is never rendered, so don't keep its data.
      suppressionReason ? {} : body.variables,
      template.meta.sensitive,
      template.meta.priority,
      suppressionReason ? 'suppressed' : 'queued',
      config.MAX_ATTEMPTS,
      template.meta.category,
      topic,
    ],
  );
  // Lost a race with a concurrent request using the same idempotency key.
  if (!rows[0]) return reply.code(200).send(await findByIdempotencyKey(ctx.appId, idempotencyKey!));

  const row = rows[0];
  return reply.code(202).send({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    ...(suppressionReason ? { suppressionReason } : {}),
  });
});

app.get<{ Params: { id: string } }>('/v1/emails/:id', async (req, reply) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const { rows } = await pool.query(
    `SELECT id, template_id, to_addr, from_addr, status, attempts, last_error, last_smtp_code,
            provider_message_id, route, created_at, updated_at, sent_at, accepted_remote_at, delivered_at, next_attempt_at
       FROM messages WHERE id = $1 AND app_id = $2`,
    [req.params.id, req.caller.appId],
  );
  const m = rows[0];
  if (!m) return reply.code(404).send({ error: 'not_found' });
  const attempts = await pool.query(
    `SELECT attempt, route, outcome, smtp_code, smtp_response, started_at, finished_at
       FROM delivery_attempts WHERE message_id = $1 ORDER BY attempt`,
    [m.id],
  );
  const events = await pool.query(
    `SELECT event_type AS type, occurred_at, detail FROM message_events WHERE message_id = $1 ORDER BY id`,
    [m.id],
  );
  return {
    id: m.id,
    template: m.template_id,
    to: m.to_addr,
    from: m.from_addr,
    status: m.status,
    attempts: m.attempts,
    lastError: m.last_error,
    lastSmtpCode: m.last_smtp_code,
    providerMessageId: m.provider_message_id,
    route: m.route,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    acceptedLocalAt: m.sent_at,
    acceptedRemoteAt: m.accepted_remote_at,
    deliveredAt: m.delivered_at,
    nextAttemptAt: m.status === 'deferred' ? m.next_attempt_at : null,
    history: attempts.rows,
    events: events.rows,
  };
});

app.get('/v1/templates', async (req) => {
  return [...templates.values()]
    .filter((t) => t.meta.products.includes(req.caller.product))
    .map((t) => ({
      id: t.id,
      description: t.meta.description,
      category: t.meta.category,
      topic: t.meta.topic,
      required: t.meta.required,
      optional: t.meta.optional,
    }));
});

// SES delivery events, delivered by SNS. Authenticated by SNS's signature, not an API key.
// SNS retries on non-2xx, so only return an error when we want the notification again.
app.post('/webhooks/ses', async (req, reply) => {
  if (config.SES_SNS_TOPIC_ARNS.length === 0) return reply.code(404).send({ error: 'not_found' });
  let msg;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    msg = await verifySnsMessage(body, config.SES_SNS_TOPIC_ARNS);
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'rejected SNS message');
    return reply.code(403).send({ error: 'invalid_sns_message' });
  }

  if (msg.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(msg.SubscribeURL)) return reply.code(403).send({ error: 'untrusted_subscribe_url' });
    const res = await fetch(msg.SubscribeURL!, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    req.log.info({ topic: msg.TopicArn, status: res.status }, 'confirmed SNS subscription');
    return reply.code(res.ok ? 200 : 502).send();
  }
  if (msg.Type === 'UnsubscribeConfirmation') {
    req.log.warn({ topic: msg.TopicArn }, 'SNS subscription removed; SES events will stop arriving');
    return reply.code(200).send();
  }

  let event: SesEvent;
  try {
    event = JSON.parse(msg.Message);
  } catch {
    req.log.warn({ snsMessageId: msg.MessageId }, 'SNS notification is not an SES event');
    return reply.code(200).send();
  }
  const result = await applySesEvent(msg.MessageId, event);
  req.log.info({ snsMessageId: msg.MessageId, type: event.eventType ?? event.notificationType, result }, 'SES event');
  return reply.code(200).send();
});

// Public unsubscribe endpoints (no API key; the signed token is the credential).
// GET only shows a confirmation page: mail scanners follow links, so a GET must never unsubscribe.
// POST unsubscribes, and is also what Gmail/Yahoo call for RFC 8058 one-click unsubscribe.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
  done(null, body),
);

app.get<{ Params: { token: string } }>('/u/:token', async (req, reply) => {
  const target = verifyUnsubscribe(req.params.token, config.UNSUBSCRIBE_SECRET);
  if (!target) return reply.code(404).type('text/html').send(page('This unsubscribe link is not valid.'));
  return reply.type('text/html').send(
    page(
      `Stop sending <strong>${escapeHtml(target.topic)}</strong> emails to <strong>${escapeHtml(target.email)}</strong>?` +
        `<form method="post"><button type="submit">Unsubscribe</button></form>` +
        `<p><small>You will still receive account and exam emails you need.</small></p>`,
    ),
  );
});

app.post<{ Params: { token: string } }>('/u/:token', async (req, reply) => {
  const target = verifyUnsubscribe(req.params.token, config.UNSUBSCRIBE_SECRET);
  if (!target) return reply.code(404).type('text/html').send(page('This unsubscribe link is not valid.'));
  await pool.query(
    `INSERT INTO suppressions (tenant_id, email, scope, reason) VALUES ($1, $2, $3, 'unsubscribe')
     ON CONFLICT DO NOTHING`,
    [target.tenantId, target.email, target.topic],
  );
  req.log.info({ topic: target.topic }, 'unsubscribed');
  return reply.type('text/html').send(page(`You have been unsubscribed from ${escapeHtml(target.topic)} emails.`));
});

function page(body: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Email preferences</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
${body}</body>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function headerValue(req: FastifyRequest, name: string) {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
}

async function findByIdempotencyKey(appId: string, key: string) {
  const { rows } = await pool.query(
    'SELECT id, status, created_at FROM messages WHERE app_id = $1 AND idempotency_key = $2',
    [appId, key],
  );
  const r = rows[0];
  return r ? { id: r.id, status: r.status, createdAt: r.created_at, duplicate: true } : null;
}

/** Fixed-window per-minute rate limit plus a daily quota. Returns an error code or null. */
async function checkLimits(ctx: AppContext): Promise<string | null> {
  const { rows } = await pool.query(
    `INSERT INTO rate_counters (app_id, window_start, count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (app_id, window_start) DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`,
    [ctx.appId],
  );
  if (rows[0].count > ctx.ratePerMinute) return 'rate_limited';

  const daily = await pool.query(
    `SELECT count(*)::int AS n FROM messages WHERE app_id = $1 AND created_at >= date_trunc('day', now())`,
    [ctx.appId],
  );
  if (daily.rows[0].n >= ctx.dailyQuota) return 'daily_quota_exceeded';
  return null;
}

app.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
  req.log.error(err);
  const clientError = err.statusCode !== undefined && err.statusCode < 500;
  reply.code(clientError ? err.statusCode! : 500).send({
    error: clientError ? (err.code ?? 'bad_request') : 'internal_error',
  });
});

await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}
