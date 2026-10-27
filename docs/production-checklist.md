# Production readiness checklist

Tick each item on the production server, not on a development machine. "Verified in repo" means
an automated test covers the behaviour, against simulated recipients.

## Network and identity (blockers for direct delivery)

- [ ] `deploy/preflight.sh mail.notify.<domain>` passes: outbound port 25, dedicated static IPv4, not CGNAT
- [ ] PTR of the server IP = `POSTFIX_HOSTNAME`, and its A record = the IP (set by the IP owner / us)
- [ ] IP not listed on Spamhaus ZEN/PBL, Barracuda, SpamCop (check by hand at check.spamhaus.org too)
- [ ] Written permission from the college network team to send mail from this IP

## DNS and domains

- [ ] Dedicated sending subdomain(s): `notify.` (transactional), optionally `news.` (newsletters)
- [ ] DKIM, SPF (single record), DMARC `p=none` published; `./mailctl domain verify` passes
- [ ] Return-path domain has SPF (and MX if late bounces are received)
- [ ] `postmaster@` and `abuse@` on the domain reach a person
- [ ] Google Postmaster Tools verified; Microsoft SNDS and Yahoo CFL registered

## Deployment

- [ ] `deploy/.env` filled, `chmod 600`, not in git; all secrets random and unique
- [ ] `docker compose ps`: every service healthy; `migrate` exited 0
- [ ] Cloudflare Tunnel hostname → `127.0.0.1:3100`; `/health` reachable over HTTPS
- [ ] One app per product created; keys stored in each app's secret store; test key revocation once
- [ ] `ALERT_WEBHOOK_URL` set, and a test alert received
- [ ] Weekly `postfix logrotate` cron installed
- [ ] Daily `backup.sh` cron with `BACKUP_REMOTE`; passphrase stored off the server
- [ ] A restore tested on a spare machine (`restore.sh`)

## Behaviour (verified in repo; re-check once on the server)

- [x] Jobs survive API, worker and Postfix restarts (e2e: worker restart mid-batch, 300/300)
- [x] Temporary failures retry with backoff; permanent failures stop and suppress (integration + e2e)
- [x] Duplicate API requests and batches are idempotent; duplicate events are ignored
- [x] Unauthorized requests rejected; tenants can't see each other's messages, batches or usage
- [x] Unverified sender domains and unauthorized senders refused; quotas and batch limits enforced
- [x] Bounces (immediate and late), policy rejections and complaints update status and suppression
- [x] Forged bounce/complaint reports and forged SES webhooks are rejected
- [x] Postfix refuses to relay for outside clients
- [x] All outgoing mail is DKIM-signed (signatures verified) with a signed VERP return path
- [x] OTPs are sent ahead of bulk mail (integration: before a 200-message backlog; e2e: 0.6 s during a batch)
- [ ] Burst test on the server: 10,000-recipient batch to an allowlisted test domain, with OTPs alongside

## Deliverability (only provable with real mailboxes)

- [ ] Test messages to Gmail, Outlook and the college domain show `spf=pass dkim=pass dmarc=pass` and TLS
- [ ] mail-tester.com score ≥ 9/10
- [ ] Warm-up plan followed (docs/deliverability.md §5) with no rising deferrals or spam placement
- [ ] Spam rate in Postmaster Tools < 0.1%
- [ ] Documented procedure for "OTP not received" (status lookup by message id; resend; support contact)
