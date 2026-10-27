import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3100),
  // Cloudflare Tunnel connects locally; don't expose the API on other interfaces.
  HOST: z.string().default('127.0.0.1'),
  // Public URL of this service (the Cloudflare Tunnel hostname); used in unsubscribe links.
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:3100'),
  UNSUBSCRIBE_SECRET: z.string().min(32, 'UNSUBSCRIBE_SECRET must be at least 32 characters'),
  // SMTP routes are configured in smtp.ts. Apps without their own route use this one.
  DEFAULT_ROUTE: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
});

export const config = schema.parse(process.env);
