# Self-hosted delivery: audit and plan

Audit of commit `25df7ec` (2026-10-27) before making the service independent of SES.

## Current path: API request → recipient

1. `POST /v1/emails` (`src/api.ts`): API key → app (`src/auth.ts`); template, sender, recipient
   allowlist, variable, rate and quota checks; suppression lookup; one row inserted into `messages`.
   The row is the job (Postgres queue, no broker).
2. `src/worker.ts` claims rows with `FOR UPDATE SKIP LOCKED` (priority order, 5-minute lease),
   renders the template, and calls nodemailer on the app's **route** (`src/smtp.ts`).
3. A route is any SMTP server from `SMTP_ROUTES`. The example config named `ses` (SES SMTP) as the
   default route and required its host; nothing in the repo delivers to recipients' MX servers itself.
4. The worker marks the message `sent` when that SMTP server answers 250. That only proves the
   first hop accepted it.
5. After that, status changes only through `POST /webhooks/ses` (SNS → `src/sns.ts`,
   `src/ses-events.ts`). Without SES there is no bounce or delivery information at all.

## Dependencies on SES / external providers

| Where | Dependency | Required to run? |
| --- | --- | --- |
| `.env.example` | `DEFAULT_ROUTE=ses`, `SMTP_SES_*`; worker refuses to start without a route host | **Yes**, in practice: the only documented production route |
| `src/smtp.ts` | `SES_CONFIGURATION_SET` route option | No (optional) |
| `src/worker.ts` | `X-SES-*` headers; parses SES's `250 Ok <id>` | No (only when the option is set) |
| `src/sns.ts`, `src/ses-events.ts`, `/webhooks/ses` | SNS signature check, SES event format | No (off unless `SES_SNS_TOPIC_ARNS` set), but the **only** source of delivery status |
| `docs/ses-events-setup.md`, `IMPLEMENTATION.md` | Recommend SES | Docs only |
| npm dependencies | none AWS-specific | — |

No AWS SDK is used; SES is reached only through generic SMTP. The real gap is that the system has
**no outbound MTA, no DKIM signing, and no feedback path of its own.**

## Reused as-is

API/auth/templates/idempotency/quotas, the Postgres queue and leases, retry and backoff policy,
suppressions and unsubscribe, routes (as the pluggable transport layer), recipient allowlist.
The SES adapter stays, optional and off by default.

## Changes

1. **Status model**: `sent` becomes `accepted_local` (the first SMTP hop accepted it); new
   `mta_deferred`, `accepted_remote`, `rejected`, `cancelled`. `delivered` only on real evidence (a
   DSN with `Action: delivered`). SES "Delivery" events now map to `accepted_remote`, not `delivered`.
   Status only moves forward (`status_rank()`), so late or replayed events cannot undo progress.
2. **Postfix** (`deploy/postfix/`): an outbound MTA image. It accepts submissions only from the
   internal Docker network (no open relay), delivers to recipients' MX servers on port 25, uses
   opportunistic TLS and long queue ids, and throttles per destination.
3. **DKIM** signed by the worker (nodemailer) with per-domain keys from a mounted directory, so
   there is no extra milter daemon. `npm run domain` generates keys, prints DNS records and verifies them.
4. **VERP return path** `bounce+<id>.<hmac>@<bounce domain>`, so every bounce identifies its
   message and cannot be forged for other messages.
5. **Tracker** (`src/tracker.ts`): tails Postfix's log file and records each queue id's outcome
   (`status=sent/deferred/bounced/expired`) as durable, idempotent events, then applies them.
6. **Bounce receiver** (`src/bounce-receiver.ts`): an internal SMTP listener that Postfix hands
   bounce-domain mail to. It parses DSNs (RFC 3464) and ARF complaint reports (RFC 5965).
7. **Batches**: `POST /v1/batches` stores every recipient as a bulk-priority message in one
   transaction. Includes de-duplication, progress, per-recipient results, cancellation, and a global
   bulk send-rate cap, so OTPs always go first.
8. **Isolation and admin**: verified sender domains, API key create/revoke/list, admin audit log, and
   header-injection hardening. Tenant isolation is tested.
9. **Operations**: Dockerfile and production Compose with internal networks, `/metrics`, a monitor
   with alert webhook, backup/restore scripts with off-machine copy, and a deployment guide.

## What cannot be verified from this workstation

Real delivery to Gmail and Outlook needs the production server's network: outbound port 25, a
static IP, a PTR record, and a clean IP reputation. These are checked by `deploy/preflight.sh` on
the server. Until it passes, direct delivery is **not** production-ready, and the safe test path is
the test MX stack (`deploy/docker-compose.test.yml`) plus a few real mailboxes during warm-up.
