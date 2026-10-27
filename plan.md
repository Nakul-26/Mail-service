# Detailed implementation plan: Eclipse Labs Mail Service

For your exam platform, placement platform, and alumni platform, I'd treat this as a shared internal infrastructure service with production-grade reliability and tenant isolation—not just a Postfix installation.

The service should be able to send exam instructions, OTPs, submission confirmations, placement notifications, interview updates, and alumni communications without each application implementing its own email delivery logic.

## 1. Final architecture and infrastructure

Exam · Placement · Alumni platforms

Separate app credentials and sending policies

Cloudflare Tunnel → Email API

HTTPS · API authentication · Validation · Rate limiting

PostgreSQL + RabbitMQ

Durable jobs · Tenant quotas · Delivery records · Retries

Email workers

Templates · Personalization · Suppression checks

Postfix → SMTP relay or direct delivery

TLS · DKIM signing · SMTP queue · Delivery feedback

Gmail · Outlook · College mail servers

Observability and recovery

Metrics · Alerts · Backups · Bounce processing · Disaster recovery

### Where each component should run

- College server: Email API, workers, RabbitMQ, PostgreSQL, and initially Postfix.
- Cloudflare Tunnel: Securely expose the HTTPS API. It does not carry outbound SMTP delivery to recipient mail servers.
- Domain DNS provider: Manage sending-domain records, DKIM selectors, SPF, DMARC, and verification records.
- External SMTP relay: Recommended initially for dependable production delivery.
- Optional static-IP direct delivery: Introduce only after network permissions, reverse DNS, reputation, and monitoring are ready.

Because the college server is a shared environment, get permission from its administrator before operating the mail service. Use a dedicated Linux account, restricted service permissions, isolated secrets, and a separate deployment configuration.

## 2. Phase-by-phase implementation

The phases below are ordered dependencies. Treat the timeline as a planning estimate, not a delivery guarantee.

### Phase 1 — Define requirements and sender identities

Before writing code, document:

- Estimated emails per day and peak bursts—for example, exam announcements before an exam begins.
- Required delivery latency for OTPs and password resets.
- Whether alumni communications are transactional, opt-in newsletters, or both.
- Which institution or customer owns each sending identity.
- Required availability, retention, and recovery objectives.

Create separate sender identities, for example:

| Use case            | Example sender                  |
| ------------------- | ------------------------------- |
| Exam platform       | `exams@notify.example.com`      |
| Placement platform  | `placements@notify.example.com` |
| Alumni platform     | `alumni@notify.example.com`     |
| Support and replies | `support@example.com`           |

These are examples; configure them under a domain you control. Use a dedicated sending subdomain such as `notify.example.com` to separate reputation from the main business domain.

### Phase 2 — Prepare the network and server

1. Deploy Docker Compose services on the college server.
2. Set up persistent storage for PostgreSQL, RabbitMQ, and mail queues.
3. Expose only the HTTPS API through Cloudflare Tunnel; keep database and broker ports private.
4. Restrict outbound traffic and administrator access.
5. Check the college network's outbound port 25 policy and whether a static public IP and custom PTR record are available.
6. Configure a reliable clock, security updates, log rotation, backups, and resource monitoring.

Do not assume a Cloudflare Tunnel solves SMTP networking. If you send directly, the server needs working outbound SMTP connectivity. Inbound SMTP on port 25 is only necessary if you also intend to receive email directly.

### Phase 3 — Build the API

Use Node.js + TypeScript, or Go if you prefer a smaller service.

Suggested endpoints:

| Endpoint                     | Purpose                            |
| ---------------------------- | ---------------------------------- |
| `POST /v1/emails`            | Submit a message                   |
| `POST /v1/batches`           | Submit a controlled batch          |
| `GET /v1/emails/:id`         | Retrieve message status            |
| `GET /v1/templates`          | List authorized templates          |
| `POST /v1/webhooks/provider` | Receive authenticated relay events |
| `GET /health`                | Health check                       |

For each request, authenticate the application, validate its allowed sender, enforce recipient and rate limits, check template permissions, and assign an idempotency key.

Return `202 Accepted` only after the request has been durably recorded or queued. Don't return success merely because an in-memory job was created.

### Phase 4 — Implement reliable delivery

Use RabbitMQ for queued jobs and PostgreSQL as the durable source of truth for message and delivery state.

- Use persistent jobs and publisher confirms.
- Acknowledge jobs only after processing results have been safely recorded.
- Retry temporary SMTP failures with exponential backoff and jitter.
- Do not endlessly retry invalid recipients or permanent rejections.
- Use a dead-letter queue for jobs that exceed retry limits.
- Store SMTP response codes and timestamps for troubleshooting.
- Design for duplicate processing: email delivery cannot be guaranteed exactly once simply by using a queue.

For critical workflows, use an outbox pattern so database commits and message publication cannot silently get out of sync.

### Phase 5 — Build templates and application integrations

Use a templating system such as React Email or MJML. Keep templates versioned and centrally managed.

Create templates for:

- Exam registration and exam instructions.
- OTPs, verification links, and password resets.
- Exam submission confirmations and result announcements.
- Placement drives, interview schedules, and deadlines.
- Alumni account invitations, profile verification, and approved updates.

For each template, define required variables, allowed senders, locale, expiry rules, and preview/test rendering.

Applications should send a template identifier and validated data—not arbitrary HTML supplied by the client. For OTPs, use short expirations, avoid logging the secret, and enforce resend and verification limits.

### Phase 6 — Add delivery feedback and monitoring

Track the lifecycle of each message:

`queued → sending → accepted by SMTP → delivered / bounced / deferred / failed`

An SMTP server accepting a message does not prove that it reached the inbox. Use relay webhooks where available, and process direct-delivery DSNs or bounce messages if you operate your own outbound MTA.

Build a small admin dashboard that shows:

- Sent, accepted, bounced, and failed messages.
- Delivery latency and queue age.
- Failures grouped by recipient provider and SMTP response.
- Retry counts and dead-letter jobs.
- Per-application quotas and usage.
- Suppression lists and abuse alerts.

## 3. Deliverability, DNS and networking

This is the most important part of the project. A correctly functioning API does not guarantee that an email reaches the inbox.

### DNS records you must configure

Use a dedicated sending subdomain, for example `notify.example.com`.

| Record           | Purpose                                     | Implementation                                                  |
| ---------------- | ------------------------------------------- | --------------------------------------------------------------- |
| SPF (TXT)        | Authorizes senders                          | Include every legitimate sending source                         |
| DKIM (TXT)       | Cryptographically signs messages            | Generate a key pair and publish the public key                  |
| DMARC (TXT)      | Defines handling of authentication failures | Begin with `p=none` and review reports                          |
| A / AAAA         | Maps hostnames to IP addresses              | Point to the actual sending host when sending directly          |
| PTR              | Maps sending IP back to hostname            | Configure with the IP owner or ISP                              |
| MX               | Routes incoming mail                        | Required if you receive mail or bounces directly at that domain |
| TLS certificates | Encrypt connections                         | Configure valid certificates where your services terminate TLS  |

Important distinctions:

- If an SMTP relay sends the final message, the SPF and DKIM setup must authorize and authenticate that relay. Follow its exact DNS instructions.
- If Postfix delivers directly, you need working outbound port 25, a stable sending IP, valid forward and reverse DNS, and a consistent SMTP `EHLO` hostname.
- If you operate a bounce mailbox or receive delivery-status notifications directly, you need the corresponding inbound mail routing and processing. You do not need an MX record solely to send email.
- Never publish multiple independent SPF records for the same hostname. Consolidate the authorized senders into one valid record.

Gmail's current sender guidelines require authentication, TLS, and valid forward/reverse DNS; higher-volume senders also need aligned SPF/DKIM and DMARC.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://support.google.com\&sz=32)

Gmail Help

+1



### Test networking before choosing direct delivery

Run these checks with your college administrator:

1. Does the server have a stable public IPv4 address, or is it behind NAT/CGNAT?
2. Is outbound TCP port 25 permitted by the college firewall and upstream ISP?
3. Can the owner of the IP configure PTR/rDNS?
4. Does the IP have an acceptable reputation and no relevant blocklist issues?
5. Does the hostname resolve correctly, and does the SMTP server announce that hostname consistently?

A permanent IP alone does not solve these issues. Residential and institutional networks may have unsuitable IP ranges, restrictions, or pre-existing reputation problems. Spamhaus documents the importance of reverse DNS, consistent HELO, authentication, and sender practices.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.spamhaus.org\&sz=32)

Spamhaus

+1



Decision: if any key networking requirement fails, keep the self-hosted API and queue but use an authenticated SMTP relay for outbound delivery.

## 4. IP and domain reputation

Reputation is earned by sending legitimate, expected mail consistently. A fresh domain or IP does not start with a guaranteed good reputation.

Your controls should include:

- Begin with low, predictable volumes and increase gradually.
- Send only to addresses collected legitimately through your platforms.
- Monitor deferrals, permanent rejections, spam complaints, and bounces.
- Reduce sending when providers start rate-limiting or rejecting messages.
- Check IP/domain blocklists and Google's Postmaster Tools where sufficient data is available.
- Keep transactional messages separate from alumni newsletters or other promotional traffic, ideally with separate sending identities and potentially separate delivery infrastructure.

Avoid sending an entire exam batch as one sudden burst. Use a queue with concurrency limits and provider-aware throttling.

Gmail reports that spam rates should remain below 0.1% where possible and must not reach 0.3%; its reputation and enforcement systems can affect delivery.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://support.google.com\&sz=32)

Gmail Help

+1



## 5. Abuse prevention and tenant isolation

Because three products and potentially multiple colleges will use the same service, treat every application as an untrusted client.

Implement these safeguards before production:

- Per-app API keys: independent credentials, stored as hashes, revocable without affecting other apps.
- Tenant isolation: every message, template, sender domain, usage record, and event belongs to a tenant or application.
- Verified sender domains: prevent clients from impersonating arbitrary senders.
- Rate limits and quotas: cap messages per second, per minute, per day, and per tenant.
- Recipient controls: validate addresses, restrict test environments, and block unauthorized recipient patterns.
- Suppression list: don't retry known permanent bounces, complaints, or opted-out promotional recipients.
- Abuse alerts: detect unusual volume increases, excessive failures, compromised credentials, and repeated OTP requests.
- Secret security: keep credentials out of source code, logs, and frontend applications.
- Administrative audit logs: record who changed templates, domains, quotas, or credentials.

Do not build an open relay. Postfix must not accept arbitrary messages for forwarding from unauthenticated external clients.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.postfix.org\&sz=32)

postfix.org

+1



For alumni newsletters and promotional communications, record consent and honor unsubscribes. Keep these separate from necessary transactional emails, and do not use a password-reset or exam-notification permission as blanket marketing consent.

## 6. Hosting restrictions and operational risks

Before production, resolve these infrastructure risks explicitly.

| Risk                           | Mitigation                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| College internet outage        | Durable queues; retry when connectivity returns                              |
| Server restart or power loss   | Persistent volumes, UPS where possible, tested recovery                      |
| Outbound port 25 blocked       | Authenticated SMTP relay                                                     |
| Public IP or PTR unavailable   | Use a relay instead of direct delivery                                       |
| Cloudflare Tunnel unavailable  | Monitor tunnel health; maintain an authorized recovery route                 |
| Server disk fills up           | Disk alerts, log rotation, queue limits and retention policies               |
| Database or queue corruption   | Backups and periodic restore tests                                           |
| College server access changes  | Document ownership, service accounts, permissions and recovery procedures    |
| Provider rejects a large batch | Throttle sending, preserve jobs, inspect SMTP errors and retry appropriately |

Cloudflare Tunnel is suitable for the HTTPS API, but don't route outbound SMTP through it as though it were a mail relay.

For production, also define who will maintain the service, rotate credentials, investigate delivery failures, and restore the system if the college server becomes unavailable.

## 7. Testing and production acceptance

Don't launch based only on a successful test email. Use a checklist that verifies the entire lifecycle.

## Production readiness checklist

0/15

DNS and networking

SPF, DKIM and DMARC pass on received test messages

TLS works and direct-delivery PTR/EHLO checks pass if applicable

SMTP relay credentials or direct delivery connectivity work

Reliability

Jobs survive API, worker and server restarts

Temporary failures retry; permanent failures stop

Duplicate jobs and repeated API requests are handled safely

Database and queue backups can be restored

Security and abuse

Unauthorized requests are rejected

Tenants cannot access each other's messages or templates

Sender verification, quotas and rate limits work

Bounces, complaints and unsubscribe events update suppression rules

Production readiness

Exam and placement burst tests pass at expected peak load

Alerts trigger for queue age, disk pressure and delivery failures

Critical email failure procedures are documented

A controlled rollout succeeds across Gmail, Outlook and college mailboxes

## 8. Recommended delivery strategy

Stage 1: Production MVP

Self-host the API, database, queue, workers and dashboard on the college server. Use an authenticated SMTP relay for actual delivery. Configure your own sending domain and authentication.

Stage 2: Harden and scale

Test exam-day bursts, tenant quotas, backups, failure recovery, delivery feedback and monitoring. Add provider-aware throttling and documented operational procedures.

Stage 3: Evaluate direct SMTP

Only if the college network, public IP, PTR records, IP reputation and operational requirements are suitable, test direct delivery gradually. Keep the relay available as a fallback.

### Official references

- [Gmail sender guidelines](https://support.google.com/mail/answer/81126?utm_source=chatgpt.com) — authentication, DNS, TLS and reputation.
- [Gmail sender guidelines FAQ](https://support.google.com/mail/answer/14229414?utm_source=chatgpt.com) — current enforcement and bulk sender requirements.
- [Postfix documentation](https://www.postfix.org/documentation.html?utm_source=chatgpt.com) — mail transfer configuration, queues and TLS.
- [Spamhaus sender guidelines](https://www.spamhaus.org/sender-guidelines/?utm_source=chatgpt.com) — IP reputation, DNS hygiene and abuse prevention.

My final recommendation: build this as a shared Eclipse Labs email platform, with strict per-tenant isolation and self-hosted processing, but use an established SMTP relay initially for dependable delivery. Direct SMTP should be a later, evidence-based decision—not a prerequisite for launching the service.