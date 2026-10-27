import { statfs, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';

/** Liveness: a row in service_heartbeats (for the monitor) and a file (for the container healthcheck). */
export async function heartbeat(name: string, info: Record<string, unknown> = {}) {
  await pool.query(
    `INSERT INTO service_heartbeats (name, at, info) VALUES ($1, now(), $2)
     ON CONFLICT (name) DO UPDATE SET at = now(), info = $2`,
    [name, JSON.stringify(info)],
  );
  await writeFile('/tmp/heartbeat', String(Date.now())).catch(() => {});
}

export interface Alert {
  key: string;
  severity: 'warning' | 'critical';
  message: string;
}

// Thresholds are deliberately simple; tune them once real traffic patterns are known.
export async function runChecks(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const one = async <T>(sql: string): Promise<T> => (await pool.query(sql)).rows[0] as T;

  const urgent = await one<{ n: number; age: number }>(
    `SELECT count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::int AS age
       FROM messages WHERE status IN ('queued', 'deferred') AND priority < 2 AND next_attempt_at <= now()`,
  );
  if (urgent.age > 120) {
    alerts.push({ key: 'urgent_queue_age', severity: 'critical', message: `${urgent.n} OTP/transactional messages waiting, oldest ${urgent.age}s. Is the worker running?` });
  }

  const beats = await pool.query(`SELECT name, EXTRACT(EPOCH FROM now() - at)::int AS age FROM service_heartbeats`);
  for (const b of beats.rows) {
    if (b.age > 120) alerts.push({ key: `heartbeat_${b.name}`, severity: 'critical', message: `${b.name} has not reported for ${b.age}s` });
  }

  const mta = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages
      WHERE status IN ('accepted_local', 'mta_deferred') AND sent_at < now() - interval '30 minutes'`,
  );
  if (mta.n > 0) {
    alerts.push({ key: 'mta_backlog', severity: 'warning', message: `${mta.n} messages accepted by Postfix over 30 min ago without a final result (blocked port 25? remote servers deferring?)` });
  }

  const recent = await one<{ total: number; failed: number; rejected: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('bounced', 'failed'))::int AS failed,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected
       FROM messages WHERE updated_at > now() - interval '15 minutes' AND status_rank(status) >= 2`,
  );
  if (recent.total >= 20 && recent.failed / recent.total > 0.1) {
    alerts.push({ key: 'failure_rate', severity: 'warning', message: `${recent.failed} of ${recent.total} recent messages bounced or failed` });
  }
  if (recent.rejected >= 5) {
    alerts.push({ key: 'policy_rejections', severity: 'critical', message: `${recent.rejected} messages refused by recipient servers for policy/spam reasons in 15 min. Check DKIM/SPF/PTR and blocklists; consider pausing bulk mail.` });
  }

  // Abnormal volume: an app sending far more in the last hour than its usual hourly average.
  const volume = await pool.query(
    `SELECT a.name,
            count(*) FILTER (WHERE m.created_at > now() - interval '1 hour')::int AS last_hour,
            (count(*) FILTER (WHERE m.created_at <= now() - interval '1 hour') / (7 * 24.0))::float AS avg_hour
       FROM messages m JOIN apps a ON a.id = m.app_id
      WHERE m.created_at > now() - interval '7 days'
      GROUP BY a.name`,
  );
  for (const v of volume.rows) {
    if (v.last_hour > 500 && v.last_hour > 5 * Math.max(v.avg_hour, 1)) {
      alerts.push({ key: `volume_${v.name}`, severity: 'warning', message: `${v.name} sent ${v.last_hour} messages in the last hour (usual ~${Math.round(v.avg_hour)}/h). Expected announcement, or a leaked API key?` });
    }
  }

  const tracker = await one<{ lag: number | null; pending: number }>(
    `SELECT (SELECT EXTRACT(EPOCH FROM now() - updated_at) FROM tracker_state WHERE name = 'postfix-log')::int AS lag,
            (SELECT count(*) FROM mta_log_events WHERE processed_at IS NULL AND created_at < now() - interval '10 minutes')::int AS pending`,
  );
  if (tracker.pending > 0) {
    alerts.push({ key: 'tracker_stuck', severity: 'warning', message: `${tracker.pending} Postfix log events older than 10 min not applied yet` });
  }

  for (const path of [dirname(config.POSTFIX_LOG_FILE), '/']) {
    try {
      const s = await statfs(path);
      const free = s.bavail / s.blocks;
      if (free < 0.1) alerts.push({ key: `disk_${path}`, severity: 'critical', message: `only ${(free * 100).toFixed(1)}% disk free at ${path}` });
    } catch {
      // path not present in this container
    }
  }
  return alerts;
}

/** Logs every alert; sends each to ALERT_WEBHOOK_URL at most once per 30 minutes while it persists. */
export async function sendAlerts(alerts: Alert[]) {
  for (const a of alerts) {
    console.error(`ALERT [${a.severity}] ${a.message}`);
    const { rows } = await pool.query(
      `INSERT INTO alert_state (key, last_sent, last_value) VALUES ($1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET last_sent = now(), last_value = $2
         WHERE alert_state.last_sent < now() - interval '30 minutes'
       RETURNING key`,
      [a.key, a.message],
    );
    if (!rows[0] || !config.ALERT_WEBHOOK_URL) continue;
    const text = `[eclipse-mail ${a.severity}] ${a.message}`;
    await fetch(config.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // "text" for Slack/Mattermost, "content" for Discord.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => console.error('alert webhook failed', err.message));
  }
}
