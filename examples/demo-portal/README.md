# Demo exam portal

A minimal app that uses the mail service as a real product would: OTP login, an exam
announcement batch to dummy candidates, and live status. It talks to the mail service over HTTP
with an API key that stays on the server side, never in the browser.

## Run it (dummy mode: everything lands in Mailpit, nothing leaves the machine)

```sh
docker compose up -d --wait          # Postgres + Mailpit (from the repo root)
npm run migrate
npm run create-app -- "Demo College" demo-exam-portal exam exams@notify.example.com
# put the printed key in examples/demo-portal/.env (git-ignored):
#   MAIL_API_URL=http://127.0.0.1:3100
#   MAIL_API_KEY=<key>
#   PORT=4000
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2
npm run demo           # terminal 3 -> http://127.0.0.1:4000
```

Open Mailpit at http://localhost:8025 to read the emails and copy the OTP.

## What to try

1. **OTP login**: send a code, read it in Mailpit, log in. A wrong code fails, and a used code
   can't be reused.
2. **Announcement**: send 1,000 or so. The bulk lane is rate-capped (`BULK_RATE_PER_SECOND`), so
   send an OTP while it runs; the OTP still arrives within about a second.
3. **Usage**: today's count against the app's daily quota.

With Mailpit (a `relay` route) the last status is `accepted_local`. Against the self-hosted Postfix
stack (`deploy/e2e-selfhosted.sh`) messages continue to `accepted_remote`, `bounced` and so on.
To point the demo at a deployed service, change `MAIL_API_URL` and use that deployment's key.
