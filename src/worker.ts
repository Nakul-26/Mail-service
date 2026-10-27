import { setTimeout as sleep } from 'node:timers/promises';
import { composeMail } from './compose.js';
import { config } from './config.js';
import { pool } from './db.js';
import { classifySmtpError, retryDelayMs, type Outcome } from './delivery.js';
import { dkimKeyFor } from './dkim.js';
import { heartbeat } from './monitor.js';
import { closeRoutes, defaultRoute, nextHopMessageId, routes } from './smtp.js';
import { findSuppression } from './suppressions.js';
import { templates } from './templates.js';
import { TokenBucket } from './token-bucket.js';

interface Job {
  id: string;
  app_id: string;
  tenant_id: string;
  template_id: string;
  from_addr: string;
  to_addr: string;
  variables: Record<string, unknown>;
  sensitive_keys: string[];
  attempts: number;
  max_attempts: number;
  category: 'transactional' | 'marketing';
  topic: string | null;
  route: string; // the app's route, or DEFAULT_ROUTE
}

const LEASE = '5 minutes'; // must exceed the SMTP timeouts in smtp.ts
let running = true;

// Two lanes. Urgent (priority 0 OTPs, 1 transactional) is always claimed first and is not
// rate-capped. Bulk (priority 2: batches, newsletters) only fills spare slots, at most
// BULK_RATE_PER_SECOND, so a 10,000-recipient batch can't delay an OTP by more than one cycle.
async function claim(limit: number): Promise<Job[]> {
  const urgent = await claimLane('m2.priority < 2', limit);
  const room = limit - urgent.length;
  if (room === 0) return urgent;
  const allowed = bulkTokens.take(room);
  if (allowed === 0) return urgent;
  const bulk = await claimLane('m2.priority = 2', allowed);
  bulkTokens.refund(allowed - bulk.length);
  return [...urgent, ...bulk];
}

// Also reclaims jobs whose lease expired because a worker crashed mid-send, so delivery is
// at-least-once, not exactly-once.
async function claimLane(lane: string, limit: number): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `UPDATE messages m
        SET status = 'sending', attempts = m.attempts + 1,
            locked_until = now() + interval '${LEASE}', updated_at = now()
       FROM apps a
      WHERE a.id = m.app_id AND m.id IN (
        SELECT m2.id FROM messages m2
         WHERE ${lane}
           AND ((m2.status IN ('queued', 'deferred') AND m2.next_attempt_at <= now())
                OR (m2.status = 'sending' AND m2.locked_until < now()))
         ORDER BY m2.priority, m2.next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING m.id, m.app_id, m.template_id, m.from_addr, m.to_addr, m.variables,
                m.sensitive_keys, m.attempts, m.max_attempts, m.category, m.topic,
                a.tenant_id, COALESCE(a.route, $2) AS route`,
    [limit, defaultRoute],
  );
  return rows;
}

const bulkTokens = new TokenBucket(config.BULK_RATE_PER_SECOND);

type Accepted = { kind: 'accepted'; code?: number; response: string };

// Every state change is conditioned on (id, attempts) so a worker whose lease expired
// cannot overwrite the result of the worker that took the job over.
async function finish(
  job: Job,
  startedAt: Date,
  status: 'accepted_local' | 'deferred' | 'failed' | 'suppressed',
  outcome: Outcome | Accepted,
  extra: { nextHopId?: string; retryInMs?: number } = {},
) {
  const terminal = status !== 'deferred';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE messages
          SET status = $3::message_status, locked_until = NULL, updated_at = now(),
              last_error = $4, last_smtp_code = $5,
              provider_message_id = COALESCE($6, provider_message_id),
              route = $9,
              sent_at = CASE WHEN $3::text = 'accepted_local' THEN now() ELSE sent_at END,
              next_attempt_at = CASE WHEN $7::int IS NULL THEN next_attempt_at
                                     ELSE now() + make_interval(secs => $7::int / 1000.0) END,
              variables = CASE WHEN $8::boolean THEN variables - sensitive_keys ELSE variables END
        WHERE id = $1 AND attempts = $2 AND status = 'sending'`,
      [
        job.id,
        job.attempts,
        status,
        outcome.kind === 'accepted' ? null : outcome.response,
        outcome.code ?? null,
        extra.nextHopId ?? null,
        extra.retryInMs ?? null,
        terminal,
        status === 'suppressed' ? null : job.route,
      ],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      console.warn(`message ${job.id}: lease lost, result discarded`);
      return;
    }
    if (status !== 'suppressed') {
      await client.query(
        `INSERT INTO delivery_attempts (message_id, attempt, started_at, outcome, smtp_code, smtp_response, route)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [job.id, job.attempts, startedAt, outcome.kind, outcome.code ?? null, outcome.response, job.route],
      );
    }
    if (outcome.kind === 'permanent' && outcome.suppressRecipient) {
      await client.query(
        `INSERT INTO suppressions (tenant_id, email, reason, detail) VALUES ($1, $2, 'hard_bounce', $3)
         ON CONFLICT DO NOTHING`,
        [job.tenant_id, job.to_addr, outcome.response],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A problem with our own setup (unknown route, missing DKIM key) is not the message's fault:
// defer so it goes out once fixed, or fails visibly after max attempts.
function configProblem(job: Job, startedAt: Date, response: string) {
  console.error(`message ${job.id}: ${response}`);
  return job.attempts >= job.max_attempts
    ? finish(job, startedAt, 'failed', { kind: 'permanent', response, suppressRecipient: false })
    : finish(job, startedAt, 'deferred', { kind: 'temporary', response }, { retryInMs: retryDelayMs(job.attempts) });
}

async function processJob(job: Job) {
  const startedAt = new Date();

  // The recipient may have been suppressed after the message was queued.
  const suppressionReason = await findSuppression(pool, job.tenant_id, job.to_addr, job.topic);
  if (suppressionReason) {
    return finish(job, startedAt, 'suppressed', { kind: 'accepted', response: `recipient suppressed: ${suppressionReason}` });
  }

  const template = templates.get(job.template_id);
  if (!template) {
    return finish(job, startedAt, 'failed', {
      kind: 'permanent',
      response: `template "${job.template_id}" no longer exists`,
      suppressRecipient: false,
    });
  }

  const route = routes.get(job.route);
  if (!route) return configProblem(job, startedAt, `SMTP route "${job.route}" is not configured`);

  const composed = composeMail(job, route, template, {
    publicBaseUrl: config.PUBLIC_BASE_URL,
    unsubscribeSecret: config.UNSUBSCRIBE_SECRET,
    bounceSecret: config.BOUNCE_SECRET,
    dkim: dkimKeyFor(job.from_addr.split('@')[1]!, config.DKIM_KEYS_DIR),
  });
  if (!composed.ok) return configProblem(job, startedAt, composed.error);

  try {
    const info = await route.transport.sendMail(composed.mail);
    await finish(
      job,
      startedAt,
      'accepted_local',
      { kind: 'accepted', code: 250, response: String(info.response ?? '') },
      { nextHopId: nextHopMessageId(info.response) ?? info.messageId },
    );
    console.log(`message ${job.id}: accepted by ${job.route} (attempt ${job.attempts})`);
  } catch (err) {
    const outcome = classifySmtpError(err);
    if (outcome.kind === 'permanent' || job.attempts >= job.max_attempts) {
      await finish(job, startedAt, 'failed', outcome);
      console.warn(`message ${job.id}: failed permanently: ${outcome.response}`);
    } else {
      const retryInMs = retryDelayMs(job.attempts);
      await finish(job, startedAt, 'deferred', outcome, { retryInMs });
      console.warn(`message ${job.id}: deferred ${Math.round(retryInMs / 1000)}s: ${outcome.response}`);
    }
  }
}

async function housekeeping() {
  await pool.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '1 day'`);
}

async function main() {
  const summary = [...routes.values()].map((r) => `${r.name}(${r.kind})`).join(', ');
  console.log(`worker started (concurrency ${config.WORKER_CONCURRENCY}, routes: ${summary}, default: ${defaultRoute})`);
  let lastHousekeeping = 0;
  let lastBeat = 0;
  while (running) {
    try {
      if (Date.now() - lastBeat > 10_000) {
        await heartbeat('worker', { routes: [...routes.keys()] });
        lastBeat = Date.now();
      }
      if (Date.now() - lastHousekeeping > 10 * 60_000) {
        await housekeeping();
        lastHousekeeping = Date.now();
      }
      const jobs = await claim(config.WORKER_CONCURRENCY);
      if (jobs.length === 0) {
        await sleep(config.WORKER_POLL_MS);
        continue;
      }
      // A failure in one job must not take down the batch; its lease will expire and it is retried.
      const results = await Promise.allSettled(jobs.map(processJob));
      for (const r of results) if (r.status === 'rejected') console.error('job error', r.reason);
    } catch (err) {
      console.error('worker loop error', err);
      await sleep(5000);
    }
  }
  closeRoutes();
  await pool.end();
  console.log('worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, finishing in-flight jobs`);
    running = false;
  });
}

await main();
