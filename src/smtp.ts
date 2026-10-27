import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { config } from './config.js';

// Named sending routes. Each app sends via DEFAULT_ROUTE unless set with `npm run set-route`.
// SMTP_ROUTES=postfix,relay1 reads SMTP_POSTFIX_HOST, SMTP_POSTFIX_PORT, ... and SMTP_RELAY1_HOST, ...
// Without SMTP_ROUTES, the plain SMTP_HOST, SMTP_PORT, ... variables form one route named "default".
//
// KIND=postfix: our own MTA (deploy/postfix). Messages must be DKIM-signed and use a VERP return path,
//               and their delivery is tracked from Postfix's log and bounce messages.
// KIND=relay:   any other SMTP server (an external provider, or Mailpit in development). Used only if
//               explicitly configured; there is no automatic fallback between routes.

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const routeFields = z.object({
  KIND: z.enum(['postfix', 'relay']).default('relay'),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().default(587),
  SECURE: bool.default(false),
  REQUIRE_TLS: bool.default(true),
  USER: z.string().optional(),
  PASS: z.string().optional(),
  // Stay under the route's sending limit. 0 = unlimited.
  RATE_PER_SECOND: z.coerce.number().int().min(0).default(0),
  // Return-path domain for bounces: bounce+<id>-<mac>@VERP_DOMAIN. Required for postfix routes.
  VERP_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).optional(),
  // Refuse to send unsigned mail. Defaults to true for postfix routes.
  REQUIRE_DKIM: bool.optional(),
  // Optional SES adapter: messages carry this configuration set so SES reports their events to
  // /webhooks/ses. Only meaningful for a relay route that is SES.
  SES_CONFIGURATION_SET: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const routeSchema = routeFields.superRefine((r, ctx) => {
  if (r.KIND === 'postfix' && !r.VERP_DOMAIN) {
    ctx.addIssue({ code: 'custom', path: ['VERP_DOMAIN'], message: 'required for KIND=postfix' });
  }
});

export interface Route {
  name: string;
  kind: 'postfix' | 'relay';
  transport: Transporter;
  verpDomain?: string;
  requireDkim: boolean;
  sesConfigurationSet?: string;
}

export function readRoute(name: string, prefix: string, env: NodeJS.ProcessEnv = process.env): Route {
  const fields = Object.keys(routeFields.shape).map((k) => [k, env[`${prefix}${k}`] || undefined]);
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
  return {
    name,
    kind: r.KIND,
    transport,
    verpDomain: r.VERP_DOMAIN?.toLowerCase(),
    requireDkim: r.REQUIRE_DKIM ?? r.KIND === 'postfix',
    sesConfigurationSet: r.SES_CONFIGURATION_SET,
  };
}

export function loadRoutes(env: NodeJS.ProcessEnv = process.env): Map<string, Route> {
  const names = (env.SMTP_ROUTES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const routes = new Map<string, Route>();
  if (names.length === 0) {
    routes.set('default', readRoute('default', 'SMTP_', env));
  } else {
    for (const name of names) {
      if (!/^[a-z0-9]+$/.test(name)) throw new Error(`SMTP route name "${name}" must be lowercase letters/digits`);
      routes.set(name, readRoute(name, `SMTP_${name.toUpperCase()}_`, env));
    }
  }
  if ([...routes.values()].some((r) => r.verpDomain) && !config.BOUNCE_SECRET) {
    throw new Error('BOUNCE_SECRET is required when a route sets VERP_DOMAIN');
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

/**
 * The id the next hop gave the message, from its 250 reply:
 * Postfix "250 2.0.0 Ok: queued as 4ZxY...", SES "250 Ok 0109019a...-000000".
 */
export function nextHopMessageId(response: unknown): string | undefined {
  const r = String(response ?? '');
  return /queued as ([A-Za-z0-9]+)/.exec(r)?.[1] ?? /^250 Ok (\S+)/i.exec(r)?.[1];
}
