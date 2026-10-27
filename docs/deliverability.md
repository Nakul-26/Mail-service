# Direct delivery: DNS, network and deliverability requirements

The mail service delivers directly from our server to Gmail, Outlook, college servers and others.
Running software correctly is the easy part. Whether mail is **accepted** depends on our IP and
DNS, and whether it reaches the **inbox** depends on reputation. None of that can be verified from a
development machine. Every item below must be checked on the production server.

> Status as of this commit: the full pipeline (API → queue → worker → Postfix with DKIM/VERP →
> tracker) is tested end to end against a **simulated** recipient server
> (`deploy/e2e-selfhosted.sh`). **No message has been delivered to a real external mailbox yet.**

## 1. Blockers to check first (`deploy/preflight.sh`)

Run `./preflight.sh <mail hostname>` on the server. Any FAIL means direct delivery cannot work yet.

| Requirement | Why | Who fixes it |
| --- | --- | --- |
| **Outbound TCP 25** to the internet | Servers deliver to each other on port 25 only. Many campus and ISP networks block it. | College network team / ISP |
| **Static public IPv4, used only by this server** | Receivers judge the sending IP. A campus NAT address is shared with every lab PC, so any infected machine can get it blocklisted, and its PTR can't name our server. | College network team / ISP |
| **Not CGNAT** (100.64.0.0/10) | No inbound reachability and no PTR possible. Direct delivery is impossible. | ISP (needs a different connection) |
| **PTR (reverse DNS)** for that IP → `mail.notify.<domain>` | Gmail and Outlook reject or junk mail from IPs without matching reverse DNS. Only the **owner of the IP** can set it, not our DNS provider. | College network team / ISP |
| **A record** `mail.notify.<domain>` → that IP (forward-confirmed reverse DNS) | PTR and A must point at each other. | Us (DNS) |
| **EHLO name** = that hostname | Postfix uses `POSTFIX_HOSTNAME` for EHLO; it must equal the PTR name. | Us (`deploy/.env`) |
| **IP not on blocklists** (Spamhaus ZEN/PBL, Barracuda, SpamCop) | Listed IPs are rejected outright. Spamhaus PBL lists most residential/dynamic ranges by design. | IP owner requests delisting / PBL removal |

**Cloudflare Tunnel does not help here.** It carries inbound HTTPS to the API only. It does not
carry outbound SMTP, does not give the server a public IP, and does not provide reverse DNS.

If any blocker cannot be fixed, **do not route production mail through Postfix**. Options, in order
of independence:

1. **A small VPS as the outbound MTA** (only Postfix runs there; the API, queue, database and tracker
   stay on the college server). Choose a provider that allows port 25 and lets you set PTR (e.g.
   Hetzner and OVH do on request). This keeps the system fully self-managed.
2. An external SMTP relay. This is the opposite of the goal here. It is possible only as an
   explicitly configured `KIND=relay` route (`docs/ses-events-setup.md` for SES), never as a silent fallback.

## 2. DNS records

`./mailctl domain add notify.<domain> --ip <IP> --bounce-domain bounces.notify.<domain>` generates
the DKIM key and prints the exact records. For `notify.example.com` and IP `203.0.113.10`:

| Name | Type | Value | Purpose |
| --- | --- | --- | --- |
| `s202610._domainkey.notify.example.com` | TXT | `v=DKIM1; k=rsa; p=<public key>` | DKIM: receivers verify our signature |
| `notify.example.com` | TXT | `v=spf1 ip4:203.0.113.10 -all` | SPF for the From domain |
| `_dmarc.notify.example.com` | TXT | `v=DMARC1; p=none; adkim=s; aspf=r; rua=mailto:dmarc-reports@notify.example.com` | DMARC policy and aggregate reports |
| `bounces.notify.example.com` | TXT | `v=spf1 ip4:203.0.113.10 -all` | SPF is checked against the **return-path** domain |
| `bounces.notify.example.com` | MX | `10 mail.notify.example.com` | Where remote servers send late bounces |
| `mail.notify.example.com` | A | `203.0.113.10` | Forward DNS of the EHLO name |
| PTR of `203.0.113.10` | PTR | `mail.notify.example.com` | Reverse DNS, set by the IP owner |

Notes:

- Use **dedicated subdomains** (`notify.` for OTP/exam/placement mail, optionally `news.` for alumni
  newsletters) so their reputations are separate, and the main domain is unaffected.
- **One SPF record per name.** If a name already has SPF (e.g. for Google Workspace), add the
  `ip4:` to it instead of publishing a second record.
- **Alignment:** DKIM signs with the From domain (strict alignment). The return path is a subdomain
  of the From domain, so SPF aligns under DMARC's relaxed mode.
- **DMARC rollout:** start with `p=none`, read the aggregate reports for 2–4 weeks, then move to
  `p=quarantine` and later `p=reject` once every legitimate source passes.
- Then run `./mailctl domain verify notify.<domain> --ip <IP>`. Apps cannot send from a domain until
  it is verified.
- `postmaster@` and `abuse@` on the sending domain should reach a person (RFC 2142). Route them
  through your normal mail provider.
- **DKIM rotation:** `domain add` with a new `--selector` on a fresh key, publish it, wait for DNS,
  then the worker uses the newest key automatically. Remove the old record a week later.

## 3. TLS

- **Outbound:** Postfix uses opportunistic TLS (`smtp_tls_security_level = may`). Gmail and Outlook
  both offer STARTTLS, so mail to them is encrypted. Gmail's requirements include TLS.
- **Inbound bounces** (only with `docker-compose.inbound.yml`): mount a certificate for
  `POSTFIX_HOSTNAME` as `deploy/tls/fullchain.pem` and `privkey.pem` (e.g. from Let's Encrypt via
  DNS-01, since port 80 may not be reachable). Without it, inbound STARTTLS is not offered.
- **API:** HTTPS terminates at Cloudflare; the tunnel reaches the API on `127.0.0.1:3100`.

## 4. Provider requirements (Gmail, Outlook, Yahoo)

As of 2024–2025, all three require, especially above ~5,000 messages/day to them:

- SPF **and** DKIM pass, and DMARC published (at least `p=none`) with alignment.
- Valid forward and reverse DNS for the sending IP, and TLS.
- Spam complaint rate **below 0.3%**, ideally below 0.1% (Gmail Postmaster Tools shows it).
- For marketing mail (alumni newsletters): **one-click unsubscribe** (`List-Unsubscribe` +
  `List-Unsubscribe-Post`, RFC 8058), honoured within 2 days. The service adds both headers to
  every `marketing` template and suppresses the topic immediately.
- Messages that don't impersonate Gmail/Outlook addresses in From. We only send from our verified domains.

## 5. Reputation and warm-up

A new IP has **no** reputation. Sending thousands of messages from it on day one gets them deferred,
rate-limited or junked. Plan at least 4–6 weeks before relying on it for a 10,000-recipient exam
announcement.

| Week | Daily volume (all providers) | What to send |
| --- | --- | --- |
| 1 | 20–50 | Team and demo-user mailboxes at Gmail, Outlook and college domains (`set-recipients` allowlist) |
| 2 | 100–300 | Demo exams; real low-risk transactional mail (account verification) |
| 3 | 500–1,000 | OTPs and exam/placement notifications for one cohort |
| 4–6 | double each week if deferrals and spam placement stay low | Gradually all transactional traffic |
| later | | Newsletters, last, and on the `news.` subdomain |

During warm-up, keep `BULK_RATE_PER_SECOND` low (1–2) and `POSTFIX_DESTINATION_CONCURRENCY` at 2–5.
**Back off immediately** if the monitor reports policy rejections (5.7.x), Gmail answers
`421-4.7.28` (rate limiting for unauthenticated or unknown senders), or Outlook answers
`550 5.7.1 ... S3150` (IP blocked).

Register the IP and domain with:

- **Google Postmaster Tools**: domain reputation and spam rate; needs a DNS TXT verification.
- **Microsoft SNDS**: IP data and JMRP complaint reports for Outlook/Hotmail.
- **Yahoo Complaint Feedback Loop**: complaint reports (ARF).

## 6. Bounces and complaints: what is tracked, and the limits

| Signal | How it reaches us | Status | Suppression |
| --- | --- | --- | --- |
| Postfix accepted the message | worker's SMTP 250 | `accepted_local` | — |
| Recipient's server accepted it | Postfix log `status=sent` | `accepted_remote` | — |
| Temporary failure, Postfix retrying | Postfix log `status=deferred` | `mta_deferred` | — |
| Unknown address (5.1.x, 5.2.1) during delivery | Postfix log `status=bounced` | `bounced` | all mail to the address |
| Policy/spam refusal (5.7.x) | Postfix log | `rejected` | none (it's about us, not the address) |
| Retries exhausted | Postfix log `status=expired` | `failed` | — |
| Late bounce sent afterwards by the remote server | DSN email to the VERP return path → bounce receiver | `bounced` | as above |
| Complaint (Yahoo CFL, Microsoft JMRP) | ARF email to `fbl@<bounce domain>` → bounce receiver | — | the newsletter topic (or all, for transactional mail) |
| Unsubscribe | one-click / link → `/u/:token` | — | the topic |

Limits, stated plainly:

- **`accepted_remote` is not inbox delivery.** The recipient's server accepted the message; it may
  still file it as spam. Only seed-mailbox checks and Postmaster Tools show inbox placement.
- **`delivered` is almost never set.** It requires a DSN with `Action: delivered`, which Gmail and
  Outlook don't send.
- **Late bounces and complaints need inbound mail** for the bounce domain (MX record + port 25
  reachable + `docker-compose.inbound.yml`). On a college network inbound 25 is usually closed;
  then only bounces during delivery (the large majority from Gmail/Outlook) are tracked.
- **Gmail sends no per-message complaints.** Its spam rate is visible only in Postmaster Tools.
- Forged reports can't suppress arbitrary people: DSNs are accepted only for VERP addresses whose
  HMAC is valid, and complaints only when the reported original carries one.

## 7. Testing and troubleshooting

Safe test path, in order:

1. `deploy/e2e-selfhosted.sh`: the whole stack against a simulated recipient server, on any machine.
2. `deploy/preflight.sh` on the production server.
3. A demo app locked to team mailboxes (`./mailctl set-recipients ... demo1@gmail.com @yourcollege.edu`).
   For each provider, open the received mail's headers ("Show original" in Gmail) and check
   `spf=pass`, `dkim=pass`, `dmarc=pass`, and the TLS line.
4. https://www.mail-tester.com: send one message, aim for 9/10 or higher.
5. Warm-up (section 5), watching the monitor and Postmaster Tools.

When something goes wrong:

| Symptom | Look at |
| --- | --- |
| Messages stay `accepted_local` / `mta_deferred` | `docker compose exec postfix postqueue -p` (queue + reasons); `docker compose logs postfix` |
| `connect to ...:25: Connection timed out` | outbound port 25 is blocked: section 1 |
| `550 5.7.1` / `554` mentioning PTR, rDNS, "client host rejected" | PTR missing or not matching the EHLO name |
| `550 5.7.26` (Gmail) "unauthenticated" | SPF/DKIM failing or not aligned: check DNS, run `./mailctl domain verify` |
| `421 4.7.28` (Gmail), `451 4.7.650` (Outlook) | rate limiting for a new/poor-reputation IP: slow down, keep warming up |
| `550 5.7.1 ... blocked using zen.spamhaus.org` | IP listed: request delisting from the IP owner |
| Lands in spam with all `pass` | reputation (warm-up), content, complaint rate; check Postmaster Tools |
| Status never leaves `sending` | worker crashed mid-send; the lease (5 min) returns it to the queue automatically |
