import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import { isRecipientAllowed } from './recipients.js';
import { checkSender } from './senders.js';
import { templates, validateVariables, type Template } from './templates.js';

// POST /v1/batches stores every recipient as an ordinary message row (batch_id set, bulk priority)
// in one transaction, then returns. The worker sends them through the bulk lane at
// BULK_RATE_PER_SECOND, after any OTP or transactional mail, with the usual retries, suppression
// and tracking. Accepting a batch means it is stored durably, not that anyone has received it.

const recipientSchema = z.object({
  to: z.string().email().max(254),
  variables: z.record(z.string(), z.unknown()).default({}),
});

const batchSchema = z.object({
  template: z.string().min(1),
  from: z.string().email().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  // Shared by all recipients; per-recipient variables override them.
  variables: z.record(z.string(), z.unknown()).default({}),
  recipients: z.array(z.unknown()).min(1),
});

const PENDING = ['queued', 'deferred', 'sending'];
const AT_MTA = ['accepted_local', 'mta_deferred'];
const MAX_REPORTED_ERRORS = 50;

export interface PreparedRecipient {
  to: string;
  variables: Record<string, unknown>;
}

export type PrepareResult =
  | { ok: true; recipients: PreparedRecipient[]; duplicatesRemoved: number }
  | { ok: false; errors: { index: number; to?: unknown; problem: string }[]; total: number };

/** Validates and de-duplicates batch recipients. Pure, so it is unit-tested directly. */
export function prepareRecipients(
  template: Template,
  shared: Record<string, unknown>,
  raw: unknown[],
  allowlist: string[] | null,
): PrepareResult {
  const errors: { index: number; to?: unknown; problem: string }[] = [];
  const seen = new Set<string>();
  const recipients: PreparedRecipient[] = [];
  let duplicatesRemoved = 0;
  let errorCount = 0;
  raw.forEach((item, index) => {
    const report = (problem: string) => {
      errorCount++;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ index, to: (item as { to?: unknown })?.to, problem });
    };
    const parsed = recipientSchema.safeParse(item);
    if (!parsed.success) return report(parsed.error.issues.map((i) => `${i.path.join('.') || 'recipient'}: ${i.message}`).join('; '));
    const to = parsed.data.to.toLowerCase();
    if (!isRecipientAllowed(to, allowlist)) return report('recipient_not_allowed');
    const variables = { ...shared, ...parsed.data.variables };
    const problems = validateVariables(template, variables);
    if (problems.length) return report(problems.join('; '));
    if (seen.has(to)) {
      duplicatesRemoved++;
      return;
    }
    seen.add(to);
    recipients.push({ to, variables });
  });
  if (errorCount) return { ok: false, errors, total: errorCount };
  return { ok: true, recipients, duplicatesRemoved };
}

export function registerBatchRoutes(app: FastifyInstance) {
  app.post('/v1/batches', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    const body = parsed.data;
    const ctx = req.caller;
    const idempotencyKey = body.idempotencyKey ?? (typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined);

    const template = templates.get(body.template);
    if (!template || !template.meta.products.includes(ctx.product)) return reply.code(404).send({ error: 'template_not_found' });
    // OTPs and other critical mail are per-user actions, never broadcasts.
    if (template.meta.priority === 0) return reply.code(422).send({ error: 'template_not_allowed_in_batch' });

    const sender = await checkSender(ctx, body.from);
    if (!sender.ok) return reply.code(403).send({ error: sender.error, from: sender.from });

    const maxSize = Math.min(config.BATCH_MAX_RECIPIENTS, ctx.maxBatchSize);
    if (body.recipients.length > maxSize) {
      return reply.code(422).send({ error: 'batch_too_large', max: maxSize, received: body.recipients.length });
    }

    if (idempotencyKey) {
      const existing = await pool.query('SELECT id FROM batches WHERE app_id = $1 AND idempotency_key = $2', [ctx.appId, idempotencyKey]);
      if (existing.rows[0]) return reply.code(200).send({ ...(await batchSummary(ctx, existing.rows[0].id)), duplicate: true });
    }

    const prepared = prepareRecipients(template, body.variables, body.recipients, ctx.allowedRecipients);
    if (!prepared.ok) {
      return reply.code(422).send({ error: 'invalid_recipients', invalidCount: prepared.total, details: prepared.errors });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise batch inserts per app so two concurrent batches can't both pass the quota check.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ctx.appId]);
      const used = await client.query(
        `SELECT count(*)::int AS n FROM messages WHERE app_id = $1 AND created_at >= date_trunc('day', now())`,
        [ctx.appId],
      );
      const remaining = ctx.dailyQuota - used.rows[0].n;
      if (prepared.recipients.length > remaining) {
        await client.query('ROLLBACK');
        return reply.code(429).send({ error: 'daily_quota_exceeded', remaining: Math.max(0, remaining) });
      }
      const batch = await client.query(
        `INSERT INTO batches (app_id, idempotency_key, template_id, from_addr, recipient_count, duplicates_removed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (app_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [ctx.appId, idempotencyKey ?? null, template.id, sender.from, prepared.recipients.length, prepared.duplicatesRemoved],
      );
      if (!batch.rows[0]) {
        // Lost a race with a concurrent request using the same idempotency key.
        await client.query('ROLLBACK');
        const existing = await pool.query('SELECT id FROM batches WHERE app_id = $1 AND idempotency_key = $2', [ctx.appId, idempotencyKey]);
        return reply.code(200).send({ ...(await batchSummary(ctx, existing.rows[0].id)), duplicate: true });
      }
      const batchId = batch.rows[0].id;
      const topic = template.meta.topic ?? null;
      const inserted = await client.query(
        `INSERT INTO messages (app_id, batch_id, template_id, from_addr, to_addr, variables, sensitive_keys,
                               priority, status, max_attempts, category, topic)
         SELECT $1, $2, $3, $4, r.to_addr,
                CASE WHEN s.reason IS NULL THEN r.variables ELSE '{}'::jsonb END,
                $5, 2, CASE WHEN s.reason IS NULL THEN 'queued' ELSE 'suppressed' END::message_status,
                $6, $7, $8
           FROM jsonb_to_recordset($9::jsonb) AS r(to_addr text, variables jsonb)
           LEFT JOIN LATERAL (
             SELECT reason FROM suppressions
              WHERE tenant_id = $10 AND email = r.to_addr AND (scope = 'all' OR scope = $8)
              LIMIT 1) s ON true
         RETURNING status`,
        [
          ctx.appId,
          batchId,
          template.id,
          sender.from,
          template.meta.sensitive,
          config.MAX_ATTEMPTS,
          template.meta.category,
          topic,
          JSON.stringify(prepared.recipients.map((r) => ({ to_addr: r.to, variables: r.variables }))),
          ctx.tenantId,
        ],
      );
      await client.query('COMMIT');
      const suppressed = inserted.rows.filter((r) => r.status === 'suppressed').length;
      req.log.info({ batchId, app: ctx.appName, recipients: inserted.rowCount, suppressed }, 'batch accepted');
      return reply.code(202).send({
        id: batchId,
        state: 'accepted',
        recipients: inserted.rowCount,
        duplicatesRemoved: prepared.duplicatesRemoved,
        suppressed,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>('/v1/batches/:id', async (req, reply) => {
    const summary = await batchSummary(req.caller, req.params.id);
    return summary ? summary : reply.code(404).send({ error: 'not_found' });
  });

  const listQuery = z.object({
    status: z.string().regex(/^[a-z_]+$/).optional(),
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  });

  app.get<{ Params: { id: string } }>('/v1/batches/:id/recipients', async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request', details: q.error.issues });
    if (!(await ownsBatch(req.caller, req.params.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await pool.query(
      `SELECT id, to_addr, status, attempts, last_error, accepted_remote_at, updated_at
         FROM messages
        WHERE batch_id = $1 AND app_id = $2
          AND ($3::text IS NULL OR status::text = $3)
          AND ($4::uuid IS NULL OR id > $4)
        ORDER BY id LIMIT $5`,
      [req.params.id, req.caller.appId, q.data.status ?? null, q.data.after ?? null, q.data.limit],
    );
    return {
      recipients: rows.map((r) => ({
        messageId: r.id,
        to: r.to_addr,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        acceptedRemoteAt: r.accepted_remote_at,
        updatedAt: r.updated_at,
      })),
      next: rows.length === q.data.limit ? rows[rows.length - 1].id : null,
    };
  });

  // Cancels recipients not yet handed to the MTA. Messages already sending or with Postfix finish.
  app.post<{ Params: { id: string } }>('/v1/batches/:id/cancel', async (req, reply) => {
    if (!(await ownsBatch(req.caller, req.params.id))) return reply.code(404).send({ error: 'not_found' });
    const cancelled = await pool.query(
      `UPDATE messages SET status = 'cancelled', updated_at = now(), variables = variables - sensitive_keys
        WHERE batch_id = $1 AND app_id = $2 AND status IN ('queued', 'deferred')`,
      [req.params.id, req.caller.appId],
    );
    await pool.query('UPDATE batches SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = $1', [req.params.id]);
    req.log.info({ batchId: req.params.id, cancelled: cancelled.rowCount }, 'batch cancelled');
    return { ...(await batchSummary(req.caller, req.params.id)), cancelledNow: cancelled.rowCount };
  });
}

async function ownsBatch(ctx: AppContext, id: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(id).success) return false;
  const { rowCount } = await pool.query('SELECT 1 FROM batches WHERE id = $1 AND app_id = $2', [id, ctx.appId]);
  return !!rowCount;
}

async function batchSummary(ctx: AppContext, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const b = await pool.query('SELECT * FROM batches WHERE id = $1 AND app_id = $2', [id, ctx.appId]);
  const batch = b.rows[0];
  if (!batch) return null;
  const c = await pool.query(
    'SELECT status::text, count(*)::int AS n FROM messages WHERE batch_id = $1 GROUP BY 1',
    [id],
  );
  const counts: Record<string, number> = Object.fromEntries(c.rows.map((r) => [r.status, r.n]));
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0);
  const pending = sum(PENDING);
  const atMta = sum(AT_MTA);
  const state = pending > 0 ? (batch.cancelled_at ? 'cancelling' : 'sending') : atMta > 0 ? 'awaiting_mta' : batch.cancelled_at ? 'cancelled' : 'completed';
  return {
    id: batch.id,
    template: batch.template_id,
    from: batch.from_addr,
    createdAt: batch.created_at,
    cancelledAt: batch.cancelled_at,
    recipients: batch.recipient_count,
    duplicatesRemoved: batch.duplicates_removed,
    state,
    // Progress: "pending" have not reached our MTA yet; "atMta" are with Postfix (being delivered or
    // retried); the rest are final. accepted_remote = the recipient's server took it.
    progress: { pending, atMta, final: batch.recipient_count - pending - atMta },
    counts,
  };
}
