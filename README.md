# Eclipse Labs Mail Service

Shared transactional email service for the exam, placement and alumni platforms.
See `plan.md` for the overall design and `IMPLEMENTATION.md` for decisions and milestones.

## Local development

```sh
cp .env.example .env
docker compose up -d --wait        # Postgres :5440; Mailpit sinks for the "ses" (UI :8025) and "selfhosted" (UI :8026) routes
npm install
npm run migrate
npm run create-app -- "Demo College" exam-portal exam exams@notify.example.com   # prints an API key once
npm run dev:api                    # http://127.0.0.1:3100
npm run dev:worker
npm test
```

## Sending an email

```sh
curl -X POST http://127.0.0.1:3100/v1/emails \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: otp-<user>-<attempt>" \
  -H "Content-Type: application/json" \
  -d '{"to":"student@college.edu","template":"exam-otp",
       "variables":{"name":"Asha","otp":"482913","expiresInMinutes":10}}'
# 202 {"id":"…","status":"queued"}   — repeat with the same key returns 200 + same id
```

`GET /v1/emails/:id` returns status and attempt history; `GET /v1/templates` lists templates the app may use.

## Sending routes

`SMTP_ROUTES` in `.env` names the SMTP servers mail can go out through (e.g. `ses,selfhosted`); each
route has its own `SMTP_<NAME>_*` settings. Apps use `DEFAULT_ROUTE` unless pointed elsewhere:

```sh
npm run create-app -- "Demo College" demo-exams exam exams@notify.example.com
npm run set-route -- "Demo College" demo-exams selfhosted   # "default" switches it back
```

For a demo trial, also lock the app to your demo mailboxes, so it cannot reach a real student even by
mistake (other recipients get `403 recipient_not_allowed`):

```sh
npm run set-recipients -- "Demo College" demo-exams demo1@gmail.com @demo.yourdomain.com   # "any" lifts it
```

A route change applies to the next send attempt, including queued messages. Every attempt records its
route, so routes can be compared:

```sql
SELECT route, outcome, count(*) FROM delivery_attempts GROUP BY 1, 2 ORDER BY 1, 2;
```

## Delivery events (SES)

With `SES_SNS_TOPIC_ARNS` and `SMTP_<ROUTE>_SES_CONFIGURATION_SET` set, SES reports what happened after it
accepted each message, via SNS to `POST /webhooks/ses`. Messages move on to `delivered` or `bounced`,
hard bounces and complaints are suppressed, and `GET /v1/emails/:id` lists the events. One-time AWS
setup: [docs/ses-events-setup.md](docs/ses-events-setup.md).

## Message lifecycle

`queued → sending → sent` (accepted by relay), or `deferred` (temporary failure, retried with
backoff) → eventually `sent` or `failed`. Recipients rejected with a 5xx at `RCPT TO` are added to
the tenant's suppression list; later messages to them are stored as `suppressed` and not attempted.
Delivery is at-least-once: a worker crash mid-send can cause a duplicate after its 5-minute lease expires.

## Adding a template

Create `templates/<id>/` with `meta.json`, `subject.hbs`, `html.hbs`, `text.hbs`:

```json
{ "description": "…", "products": ["exam"], "priority": 0,
  "required": ["name"], "optional": [], "sensitive": ["otp"] }
```

Priority: `0` critical (OTP, password reset), `1` transactional, `2` bulk. `sensitive` variables are
removed from the database once the message reaches a final state.

Newsletters and other opt-out mail use `"category": "marketing"` plus a `"topic"` (e.g.
`alumni-newsletter`) and priority `2`. The worker fills in `{{unsubscribeUrl}}` (which the template must
show in both html and text) and adds one-click `List-Unsubscribe` headers. Unsubscribing only stops
that topic; transactional mail to the same person still goes out. Only send marketing mail to users
who opted in — the service enforces opt-outs, the calling app owns consent.
