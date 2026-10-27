# Implementation analysis & roadmap

Companion to `plan.md`. This file records what we are actually building, the
decisions that differ from the plan, and the milestone checklist.

## Analysis of plan.md

The plan is sound on the things that matter most: self-host processing, use an
authenticated SMTP relay first, treat every app as untrusted, return `202` only
after a durable write, and design for at-least-once delivery. Changes:

### 1. Drop RabbitMQ from the MVP — use PostgreSQL as the queue

The plan already requires Postgres as the source of truth *and* an outbox to keep
Postgres and RabbitMQ in sync. At college scale (thousands to low hundreds of
thousands of emails/day) a Postgres table claimed with `FOR UPDATE SKIP LOCKED`
gives us the same guarantees with one fewer stateful service to run, back up,
and monitor on a shared server, and removes the dual-write problem entirely
(the message row *is* the job). The worker's claim logic sits behind
`src/queue.ts`, so a broker can be introduced later if throughput demands it.

### 2. No Postfix in Stage 1

With a relay, Postfix in front adds a second queue whose state we can't see
from our database. Workers talk SMTP straight to the relay (with TLS); the relay
does DKIM signing for its domain setup. Postfix returns in Stage 3 only if
direct delivery is approved.

### 3. Priority lanes (missing from the plan)

An OTP must never wait behind a 5,000-recipient exam announcement. Every message
has a `priority` (0 = critical/OTP, 1 = transactional, 2 = bulk), set by the
template, and workers claim in priority order.

### 4. Sensitive variables (OTP handling made concrete)

Templates declare `sensitive` variables (e.g. `otp`). They are never logged and
are stripped from the stored row once the message reaches a terminal state. The
mail service never *generates* OTPs — the calling app owns them.

### 5. Templates live in git, not a DB (for now)

"Versioned and centrally managed" = a `templates/` directory reviewed via pull
requests. Each template has `meta.json` (required variables, sensitive variables,
priority, which products may use it), plus Handlebars `subject`/`html`/`text`.
Clients send a template id + data, never HTML. MJML can be layered in later.

### 6. Data model: tenant → app

- **tenant** = an institution/customer (a college).
- **app** = one product inside a tenant (`exam`, `placement`, `alumni`), with its
  own API keys, allowed senders, rate limit and daily quota.
- Suppressions are per tenant; messages, attempts and quotas are per app.

### 7. Cleanup

`plan.md` contains pasted chat artifacts (favicon image links, "+1", `utm_source`
parameters). Worth removing before sharing it.

## Stage 1 milestones

- [x] **M1 – Core pipeline**: schema + migrations, API-key auth, `POST /v1/emails`
      with idempotency, sender/template/quota checks, `GET /v1/emails/:id`,
      `GET /v1/templates`, `/health`, worker with leases, retries w/ backoff +
      jitter, permanent-failure detection, recipient suppression, attempt log,
      Mailpit for local testing.
- [x] **M1.5 – Mail categories**: transactional vs marketing templates, topic-scoped
      unsubscribe (link + RFC 8058 one-click), scoped suppressions, relay rate cap,
      higher default quotas, sample `alumni-newsletter` template.
- [x] **M1.6 – Per-app sending routes**: named SMTP routes (`SMTP_ROUTES`), `apps.route`,
      `npm run set-route`, route recorded per attempt. Lets demo exams trial the self-hosted
      server while production apps stay on SES (already in use).
- [x] **M1.7 – Recipient allowlist**: `apps.allowed_recipients` (addresses or `@domain`),
      `npm run set-recipients`; keeps demo trials away from real users.
- [ ] **Next, in order**: SES event webhook (M3) → batches (M4) → self-hosted Postfix + DKIM
      as the `selfhosted` route → production deploy (Dockerfile, backups, metrics; M5).
- [ ] **M2 – Real relay + DNS**: pick relay (e.g. SES, Postmark, Brevo,
      Mailgun), configure `notify.<domain>` SPF/DKIM/DMARC(p=none), verify
      SPF/DKIM/DMARC pass in Gmail/Outlook headers.
- [ ] **M3 – Feedback loop**: `POST /v1/webhooks/provider` (signed relay events →
      delivered/bounced/complained, auto-suppress), unsubscribe for alumni/bulk mail.
- [ ] **M4 – Batches & throttling**: `POST /v1/batches`, per-recipient-domain
      concurrency limits, bulk lane rate cap.
- [ ] **M5 – Operations**: Prometheus metrics (queue age, failure rate), alerts,
      pg backups + restore drill, Cloudflare Tunnel, log rotation, admin audit log.
- [ ] **M6 – Admin dashboard**: message search, failures by provider/SMTP code,
      quotas, suppression management, key rotation.
- [ ] **M7 – Acceptance**: the production checklist in `plan.md` §7, incl. an
      exam-day burst test.

## Decisions from the stakeholder answers (2026-10-23)

| Answer | Consequence |
| --- | --- |
| Peak ~10,000 emails | Too many for one-call-per-email under a per-minute limit → **batches (M4) move up**. Default quotas raised (600/min, 20,000/day per app). Worker gets a relay send-rate cap (`SMTP_RATE_PER_SECOND`) so we never exceed the relay's limit. At e.g. 14/s, a 10k announcement drains in ~12 min. |
| OTP < 30 s | Met by priority lanes: an OTP queued behind a 10k announcement is claimed in the next worker cycle (seconds). Verify with a queue-latency metric (M5) during the burst test (M7). |
| Own domain, full DNS control | Use `notify.<domain>` for transactional mail and **`news.<domain>` for newsletters**, so newsletter complaints can't hurt OTP deliverability. Need the actual domain name. |
| Newsletters + other mail types, easy to extend | Templates now declare a `category` (`transactional` / `marketing`) and, for marketing, a `topic`. Marketing mail automatically gets an unsubscribe link and Gmail/Yahoo one-click unsubscribe headers (RFC 8058); unsubscribing from one topic never blocks OTPs or exam mail. Adding a new mail type = adding a template folder, no code change. Calling apps own consent: send marketing only to users who opted in. |
| Dedicated PC, team-controlled, Cloudflare Tunnel in place | Permission is no longer a blocker. The single PC is now the main risk: off-machine backups (e.g. to R2/S3), UPS, disk alerts. Check that outbound port 587 to the relay is allowed from the college network. |

**Relay recommendation: Amazon SES** (region `ap-south-1`). It is the cheapest at this volume
(~$0.10 per 1,000 emails, so 10k/day costs about $30/month), and its SMTP interface works with the
worker unchanged. It also reports bounces and complaints, which M3 needs. New accounts start in a
sandbox and need a production-access request describing these use cases. Alternatives: Postmark
(strong transactional reputation, costs more) or Brevo.

## Questions to settle with stakeholders (plan.md Phase 1)

1. Peak volume: largest single exam/placement announcement, and expected daily total. - 10000
2. OTP latency target (suggest: p95 < 30 s end-to-end to relay acceptance). < 30s
3. Which domain will we send from, and who controls its DNS? we have our own domain and we have control of it
4. Is alumni mail transactional only, or newsletters too (needs consent + unsubscribe)? - yes newsletter too and other things as well, allow to easily support new type of mails
5. Has the college admin approved running this on the shared server? - bro the server is given to our team and we are controling it completely we are allowed to do what ever we want, what happened is college has given us a pc completely for us, we put a linux server on it and put a cloudflare tunnel to it