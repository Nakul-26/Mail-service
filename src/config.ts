import 'dotenv/config';
import { z } from 'zod';

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3100),
  // Cloudflare Tunnel connects locally; don't expose the API on other interfaces.
  HOST: z.string().default('127.0.0.1'),
  // Public URL of this service (the Cloudflare Tunnel hostname); used in unsubscribe links.
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:3100'),
  UNSUBSCRIBE_SECRET: secret('UNSUBSCRIBE_SECRET'),
  // Signs VERP return paths (bounce+<id>-<mac>@...). Required when a route sets VERP_DOMAIN.
  BOUNCE_SECRET: secret('BOUNCE_SECRET').optional(),
  // SMTP routes are configured in smtp.ts. Apps without their own route use this one.
  DEFAULT_ROUTE: z.string().optional(),
  // <dir>/<domain>/<selector>.private, created by `npm run domain -- add`.
  DKIM_KEYS_DIR: z.string().default('./secrets/dkim'),
  // Sender domains must be added and verified with `npm run domain` before apps can use them.
  // Development only: allow any sender domain listed on the app.
  ALLOW_UNVERIFIED_SENDER_DOMAINS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  // Global cap for bulk (batch / marketing) messages per worker, so they never crowd out OTPs.
  BULK_RATE_PER_SECOND: z.coerce.number().min(0.1).default(20),
  BATCH_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(10_000),

  // Tracker: Postfix's log file (maillog_file) and the internal bounce receiver.
  POSTFIX_LOG_FILE: z.string().default('/var/log/postfix/maillog'),
  BOUNCE_RECEIVER_HOST: z.string().default('0.0.0.0'),
  BOUNCE_RECEIVER_PORT: z.coerce.number().int().default(2525),

  // Monitoring: alerts are logged and, if set, POSTed as JSON to this URL (Slack/Discord-style webhook).
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  // Bearer token for GET /metrics. Unset = /metrics only answers requests from 127.0.0.1.
  METRICS_TOKEN: z.string().min(16).optional(),

  // Optional SES adapter (off when empty): SNS topic(s) SES publishes delivery events to.
  SES_SNS_TOPIC_ARNS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});

export const config = schema.parse(process.env);
