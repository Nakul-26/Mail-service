import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { pool } from './db.js';
import { classifySmtpError, retryDelayMs, type Outcome } from './delivery.js';
import { closeRoutes, defaultRoute, routes } from './smtp.js';
import { findSuppression } from './suppressions.js';
import { render, templates, UNSUBSCRIBE_VAR } from './templates.js';
import { signUnsubscribe } from './unsubscribe.js';

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

// Claims ready jobs, highest priority first. Also reclaims jobs whose lease expired
// because a worker crashed mid-send — so delivery is at-least-once, not exactly-once.
async function claim(limit: number): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `UPDATE messages m
        SET status = 'sending', attempts = m.attempts + 1,
            locked_until = now() + interval '${LEASE}', updated_at = now()
       FROM apps a
      WHERE a.id = m.app_id AND m.id IN (
        SELECT id FROM messages
         WHERE (status IN ('queued', 'deferred') AND next_attempt_at <= now())
            OR (status = 'sending' AND locked_until < now())
         ORDER BY priority, next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING m.id, m.app_id, m.template_id, m.from_addr, m.to_addr, m.variables,
                m.sensitive_keys, m.attempts, m.max_attempts, m.category, m.topic,
                a.tenant_id, COALESCE(a.route, $2) AS route`,
    [limit, defaultRoute],
  );
  return rows;
}

// Every state change is conditioned on (id, attempts) so a worker whose lease expired
// cannot overwrite the result of the worker that took the job over.
async function finish(
  job: Job,
  startedAt: Date,
  status: 'sent' | 'deferred' | 'failed' | 'suppressed',
  outcome: Outcome | { kind: 'sent'; code?: number; response: string },
  extra: { providerMessageId?: string; retryInMs?: number } = {},
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
              sent_at = CASE WHEN $3::message_status = 'sent' THEN now() ELSE sent_at END,
              next_attempt_at = CASE WHEN $7::int IS NULL THEN next_attempt_at
                                     ELSE now() + make_interval(secs => $7::int / 1000.0) END,
              variables = CASE WHEN $8::boolean THEN variables - sensitive_keys ELSE variables END
        WHERE id = $1 AND attempts = $2 AND status = 'sending'`,
      [
        job.id,
        job.attempts,
        status,
        outcome.kind === 'sent' ? null : outcome.response,
        outcome.code ?? null,
        extra.providerMessageId ?? null,
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

async function processJob(job: Job) {
  const startedAt = new Date();

  // The recipient may have been suppressed after the message was queued.
  const suppressionReason = await findSuppression(pool, job.tenant_id, job.to_addr, job.topic);
  if (suppressionReason) {
    return finish(job, startedAt, 'suppressed', { kind: 'sent', response: `recipient suppressed: ${suppressionReason}` });
  }

  const template = templates.get(job.template_id);
  if (!template) {
    return finish(job, startedAt, 'failed', {
      kind: 'permanent',
      response: `template "${job.template_id}" no longer exists`,
      suppressRecipient: false,
    });
  }

  // An app pointed at a route that isn't configured is our config mistake, not the message's:
  // defer so it goes out once the route is fixed (or fails after max attempts, visibly).
  const route = routes.get(job.route);
  if (!route) {
    const response = `SMTP route "${job.route}" is not configured`;
    console.error(`message ${job.id}: ${response}`);
    return job.attempts >= job.max_attempts
      ? finish(job, startedAt, 'failed', { kind: 'permanent', response, suppressRecipient: false })
      : finish(job, startedAt, 'deferred', { kind: 'temporary', response }, { retryInMs: retryDelayMs(job.attempts) });
  }

  try {
    const headers: Record<string, string> = { 'X-Eclipse-Message-Id': job.id };
    let variables = job.variables;
    if (job.category === 'marketing' && job.topic) {
      const token = signUnsubscribe(
        { tenantId: job.tenant_id, email: job.to_addr, topic: job.topic },
        config.UNSUBSCRIBE_SECRET,
      );
      const unsubscribeUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/u/${token}`;
      variables = { ...variables, [UNSUBSCRIBE_VAR]: unsubscribeUrl };
      // RFC 8058 one-click unsubscribe, required by Gmail and Yahoo for bulk senders.
      headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    if (route.sesConfigurationSet) {
      // SES strips these before delivery. The tag lets /webhooks/ses match events to this message.
      headers['X-SES-CONFIGURATION-SET'] = route.sesConfigurationSet;
      headers['X-SES-MESSAGE-TAGS'] = `eclipse_id=${job.id}`;
    }
    const content = render(template, variables);
    const domain = job.from_addr.split('@')[1];
    const info = await route.transport.sendMail({
      from: job.from_addr,
      to: job.to_addr,
      ...content,
      messageId: `<${job.id}@${domain}>`,
      headers,
    });
    await finish(job, startedAt, 'sent', { kind: 'sent', code: 250, response: String(info.response ?? '') }, {
      providerMessageId: providerMessageId(info.response) ?? info.messageId,
    });
    console.log(`message ${job.id}: sent via ${job.route} (attempt ${job.attempts})`);
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

// SES answers "250 Ok <ses-message-id>"; its events refer to the message by that id.
function providerMessageId(response: unknown): string | undefined {
  return /^250 Ok (S+)/i.exec(String(response ?? ''))?.[1];
}

async function housekeeping() {
  await pool.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '1 day'`);
}

async function main() {
  console.log(
    `worker started (concurrency ${config.WORKER_CONCURRENCY}, routes: ${[...routes.keys()].join(', ')}, default: ${defaultRoute})`,
  );
  let lastHousekeeping = 0;
  while (running) {
    try {
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
