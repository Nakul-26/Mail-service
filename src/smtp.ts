import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { config } from './config.js';

// Named sending routes, e.g. "ses" for production and "selfhosted" for the demo trial.
// SMTP_ROUTES=ses,selfhosted reads SMTP_SES_HOST, SMTP_SES_PORT, ... and SMTP_SELFHOSTED_HOST, ...
// Without SMTP_ROUTES, the plain SMTP_HOST, SMTP_PORT, ... variables form one route named "default".

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const routeSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().default(587),
  SECURE: bool.default(false),
  REQUIRE_TLS: bool.default(true),
  USER: z.string().optional(),
  PASS: z.string().optional(),
  // Stay under the route's sending limit (e.g. SES starts at 14/s). 0 = unlimited.
  RATE_PER_SECOND: z.coerce.number().int().min(0).default(0),
  // SES only: messages carry this configuration set, so SES publishes their delivery events
  // (via SNS to /webhooks/ses) without changing anything else on the SES account.
  SES_CONFIGURATION_SET: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export interface Route {
  transport: Transporter;
  sesConfigurationSet?: string;
}

function readRoute(prefix: string): Route {
  const fields = Object.keys(routeSchema.shape).map((k) => [k, process.env[`${prefix}${k}`] || undefined]);
  const parsed = routeSchema.safeParse(Object.fromEntries(fields));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${prefix}${i.path.join('')}: ${i.message}`);
    throw new Error(`invalid SMTP route config: ${problems.join('; ')}`);
  }
  const r = parsed.data;
  const transport = nodemailer.createTransport({
    host: r.HOST,
    port: r.PORT,
    secure: r.SECURE,
    requireTLS: r.REQUIRE_TLS,
    auth: r.USER ? { user: r.USER, pass: r.PASS } : undefined,
    pool: true,
    maxConnections: config.WORKER_CONCURRENCY,
    ...(r.RATE_PER_SECOND > 0 ? { rateDelta: 1000, rateLimit: r.RATE_PER_SECOND } : {}),
    // Keep well under the worker's job lease (5 minutes).
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
  return { transport, sesConfigurationSet: r.SES_CONFIGURATION_SET };
}

function loadRoutes(): Map<string, Route> {
  const names = (process.env.SMTP_ROUTES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return new Map([['default', readRoute('SMTP_')]]);
  const routes = new Map<string, Route>();
  for (const name of names) {
    if (!/^[a-z0-9]+$/.test(name)) throw new Error(`SMTP route name "${name}" must be lowercase letters/digits`);
    routes.set(name, readRoute(`SMTP_${name.toUpperCase()}_`));
  }
  return routes;
}

export const routes = loadRoutes();

export const defaultRoute = config.DEFAULT_ROUTE ?? [...routes.keys()][0]!;
if (!routes.has(defaultRoute)) {
  throw new Error(`DEFAULT_ROUTE "${defaultRoute}" is not one of SMTP_ROUTES (${[...routes.keys()].join(', ')})`);
}

export function closeRoutes() {
  for (const r of routes.values()) r.transport.close();
}
