import { pool } from './db.js';

// Prometheus text exposition for GET /metrics. Every value comes from the database, so the numbers
// are the same whichever API instance answers, and survive restarts.

export async function renderMetrics(): Promise<string> {
  const out: string[] = [];
  const gauge = (name: string, help: string, rows: { labels?: Record<string, string>; value: number }[]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const r of rows) {
      const labels = r.labels
        ? `{${Object.entries(r.labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',')}}`
        : '';
      out.push(`${name}${labels} ${Number.isFinite(r.value) ? r.value : 0}`);
    }
  };

  const byStatus = await pool.query(
    `SELECT a.name AS app, m.status::text AS status, count(*)::int AS n
       FROM messages m JOIN apps a ON a.id = m.app_id
      WHERE m.created_at > now() - interval '24 hours'
      GROUP BY 1, 2`,
  );
  gauge('mail_messages_24h', 'Messages created in the last 24h, by app and current status', byStatus.rows.map((r) => ({ labels: { app: r.app, status: r.status }, value: r.n })));

  const queue = await pool.query(
    `SELECT CASE WHEN priority < 2 THEN 'urgent' ELSE 'bulk' END AS lane, count(*)::int AS n,
            COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS oldest
       FROM messages WHERE status IN ('queued', 'deferred') GROUP BY 1`,
  );
  const lanes = ['urgent', 'bulk'].map((lane) => queue.rows.find((r) => r.lane === lane) ?? { lane, n: 0, oldest: 0 });
  gauge('mail_queue_depth', 'Messages waiting for the worker', lanes.map((r) => ({ labels: { lane: r.lane }, value: r.n })));
  gauge('mail_queue_oldest_seconds', 'Age of the oldest message waiting for the worker', lanes.map((r) => ({ labels: { lane: r.lane }, value: r.oldest })));

  const atMta = await pool.query(
    `SELECT status::text AS status, count(*)::int AS n,
            COALESCE(EXTRACT(EPOCH FROM now() - min(sent_at)), 0)::float AS oldest
       FROM messages WHERE status IN ('accepted_local', 'mta_deferred') GROUP BY 1`,
  );
  gauge('mail_at_mta', 'Messages handed to the MTA without a final result yet', atMta.rows.map((r) => ({ labels: { status: r.status }, value: r.n })));
  gauge('mail_at_mta_oldest_seconds', 'Age of the oldest message waiting at the MTA', atMta.rows.map((r) => ({ labels: { status: r.status }, value: r.oldest })));

  const tracker = await pool.query(
    `SELECT (SELECT EXTRACT(EPOCH FROM now() - updated_at) FROM tracker_state WHERE name = 'postfix-log')::float AS lag,
            (SELECT count(*) FROM mta_log_events WHERE processed_at IS NULL)::int AS pending`,
  );
  gauge('mail_tracker_seconds_since_log_progress', 'Seconds since the tracker last read new Postfix log lines', [{ value: tracker.rows[0].lag ?? -1 }]);
  gauge('mail_tracker_pending_events', 'Postfix log events waiting to be applied', [{ value: tracker.rows[0].pending }]);

  const beats = await pool.query(`SELECT name, EXTRACT(EPOCH FROM now() - at)::float AS age FROM service_heartbeats`);
  gauge('mail_heartbeat_age_seconds', 'Seconds since each service last reported in', beats.rows.map((r) => ({ labels: { service: r.name }, value: r.age })));

  const supp = await pool.query(`SELECT reason, count(*)::int AS n FROM suppressions GROUP BY 1`);
  gauge('mail_suppressions', 'Suppressed recipient entries, by reason', supp.rows.map((r) => ({ labels: { reason: r.reason }, value: r.n })));

  return out.join('\n') + '\n';
}
