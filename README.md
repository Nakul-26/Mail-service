# Eclipse Labs Mail Service

Self-hosted transactional email for the exam, placement and alumni platforms: an HTTP API, a
PostgreSQL-backed queue, a worker that DKIM-signs and hands mail to our own Postfix, and a tracker
that turns Postfix's log and bounce messages into delivery status. **No third-party email provider,
AWS account or webhook is needed to send or track mail.**

- [docs/deployment.md](docs/deployment.md): deploying on the Linux server, operations, backups, rollback
- [docs/deliverability.md](docs/deliverability.md): DNS, PTR, port 25, warm-up, bounces. Read this before sending real mail.
- [docs/self-hosted-audit.md](docs/self-hosted-audit.md): how the SES dependency was removed
- [plan.md](plan.md) / [IMPLEMENTATION.md](IMPLEMENTATION.md): original plan and decisions

## How mail flows

```
app ──HTTPS (Cloudflare Tunnel)──> api ──> postgres (message row = job)
                                              │
                         worker: claim (OTPs first, bulk rate-capped), render, DKIM-sign,
                                 VERP return path ──SMTP──> postfix ──port 25──> recipient's server
                                                              │ log file          │ late bounces / complaints
                                                              v                   v
                                     tracker: Postfix log → status   bounce receiver (DSN/ARF)
```

| Status | Meaning |
| --- | --- |
| `queued`, `sending`, `deferred` | waiting for / being handled by our worker (`deferred` = worker retry with backoff) |
| `accepted_local` | our Postfix (or a configured relay) accepted it |
| `mta_deferred` | Postfix is retrying (remote server said "try later") |
| `accepted_remote` | the recipient's mail server accepted it. **Not** proof of inbox placement. |
| `delivered` | only with a delivery DSN (rare; Gmail/Outlook don't send them) |
| `bounced` / `rejected` / `failed` | bad address (suppressed) / refused for policy or spam reasons / retries exhausted |
| `suppressed` / `cancelled` | not sent: recipient suppressed / batch cancelled |

Statuses only move forward; replayed or late events can't undo progress.

## API

All `/v1` endpoints need `Authorization: Bearer <app key>` and only ever see the calling app's data.

```sh
# one message (e.g. an OTP); repeat-safe with Idempotency-Key
curl -X POST $API/v1/emails -H "Authorization: Bearer $KEY" -H "Idempotency-Key: otp-<user>-<n>" \
  -H "Content-Type: application/json" \
  -d '{"to":"student@college.edu","template":"exam-otp","variables":{"name":"Asha","otp":"482913","expiresInMinutes":10}}'
# -> 202 {"id":"…","status":"queued"}

# an announcement to up to 10,000 recipients
curl -X POST $API/v1/batches -H "Authorization: Bearer $KEY" -H "Idempotency-Key: exam-42-notice" \
  -H "Content-Type: application/json" \
  -d '{"template":"exam-instructions","variables":{"examName":"DBMS","startsAt":"10:00","examUrl":"https://…"},
       "recipients":[{"to":"a@college.edu","variables":{"name":"A"}}, …]}'
# -> 202 {"id":"…","state":"accepted","recipients":9998,"duplicatesRemoved":2,"suppressed":0}
```

| Endpoint | |
| --- | --- |
| `POST /v1/emails` | queue one message |
| `GET /v1/emails/:id` | status, attempts, delivery events |
| `POST /v1/batches` | queue a batch (validated and de-duplicated; OTP templates not allowed) |
| `GET /v1/batches/:id` | state (`sending` → `awaiting_mta` → `completed`), progress, counts by status |
| `GET /v1/batches/:id/recipients?status=&after=&limit=` | per-recipient results, paged |
| `POST /v1/batches/:id/cancel` | cancel recipients not yet handed to Postfix |
| `GET /v1/templates`, `GET /v1/usage` | templates the app may use; today's usage and quota |
| `GET /metrics` | operator metrics (Prometheus), needs `METRICS_TOKEN` |
| `GET/POST /u/:token` | public unsubscribe page / RFC 8058 one-click unsubscribe |
| `POST /webhooks/ses` | optional SES adapter, off unless configured |

Accepting a request means it is stored durably. It does not mean anyone received the email.

## Templates

`templates/<id>/` holds `meta.json`, `subject.hbs`, `html.hbs` and `text.hbs`. Adding a mail type
means adding a folder; no code change is needed.

```json
{ "description": "…", "products": ["exam"], "priority": 0,
  "required": ["name"], "optional": [], "sensitive": ["otp"] }
```

- `priority`: `0` critical (OTP), `1` transactional, `2` bulk. Batches always use the bulk lane.
- `sensitive` variables are deleted from the database once a message is final.
- `"category": "marketing"` with a `"topic"` (newsletters) adds one-click unsubscribe and requires
  `{{unsubscribeUrl}}` in the html and text. Unsubscribing stops only that topic.
- HTML escapes variables, and subjects can't contain line breaks. Clients never send raw HTML.

## Development

```sh
cp .env.example .env
docker compose up -d --wait        # Postgres :5440, Mailpit (dev SMTP sink, UI http://localhost:8025)
npm install
npm run migrate
npm run create-app -- "Demo College" exam-portal exam exams@notify.example.com   # prints an API key
npm run dev:api & npm run dev:worker
```

The dev `.env` sends through a `relay` route to Mailpit and allows unverified sender domains. To run
the real Postfix stack locally, use the end-to-end test below.

## Tests

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | unit: templates, DKIM signing (verified), VERP, Postfix log and DSN/ARF parsing, routes, policies | nothing |
| `npm run test:integration` | API auth and tenant isolation, batches, tracker (restart, rotation), bounce receiver over SMTP, the worker process against an SMTP stub (failures, retries, crash recovery, OTP priority) | Postgres (`docker compose up -d postgres`) |
| `deploy/e2e-selfhosted.sh` | the full Docker stack with real Postfix, DKIM and VERP, against a **simulated** recipient server: outcomes, late bounce, 300-recipient batch with a worker restart, open-relay probe | Docker |

None of them deliver to real mailboxes; see [deliverability.md](docs/deliverability.md) for that.

## Admin

`npm run …` in development, `deploy/mailctl …` in production. Everything is audit-logged.

- `domain add|records|verify|list`: sender domains, DKIM keys, DNS records
- `create-app`: an app (tenant + product) with its first API key
- `keys create|list|revoke`: independent, revocable API keys
- `set-route`: optional extra routes (e.g. an explicitly configured relay)
- `set-recipients`: allowlist for test apps
