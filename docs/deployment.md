# Deploying on the Linux server

Everything runs in Docker Compose from `deploy/`. Before sending real mail, read
[deliverability.md](deliverability.md) and run `deploy/preflight.sh`. The software works without
any external provider, but direct delivery depends on the network.

## What runs

| Service | Role | Networks |
| --- | --- | --- |
| `postgres` | messages, events, suppressions, apps, hashed keys, audit log | internal |
| `migrate` | applies migrations, then exits (runs before the others start) | internal |
| `api` | HTTP API on `127.0.0.1:${API_PORT}` for Cloudflare Tunnel | internal, edge |
| `worker` | renders, DKIM-signs, hands mail to Postfix; retries; bulk lane | internal |
| `tracker` | follows Postfix's log, receives bounces/complaints, runs the monitor | internal |
| `postfix` | outbound MTA: queue, retries, per-destination throttling, opportunistic TLS | internal, egress |

`internal` has no internet access. Only Postfix can open outbound connections, and only the API
port is published, on `127.0.0.1`. Postfix accepts submissions only from the internal subnet, and
from anywhere else only mail for the bounce domain (no open relay).

## 1. Prepare the server

- Linux with Docker Engine 24+ and the Compose plugin; 2 CPU, 2–4 GB RAM, 20 GB+ disk.
- A dedicated user (e.g. `mail`) in the `docker` group; deploy to `/opt/eclipse-mail`.
- Time sync (`timedatectl set-ntp true`), automatic security updates.
- Firewall: no inbound ports needed (the API is reached through the tunnel). Allow **outbound TCP 25**
  (delivery) and 443. Inbound 25 only if you enable late-bounce reception.
- Run the network check: `./deploy/preflight.sh mail.notify.<domain>`.

```sh
sudo mkdir -p /opt/eclipse-mail && sudo chown mail: /opt/eclipse-mail
git clone https://github.com/Nakul-26/Mail-service.git /opt/eclipse-mail
cd /opt/eclipse-mail/deploy
cp .env.example .env && chmod 600 .env    # fill in secrets and hostnames (openssl rand -base64 36)
mkdir -p secrets/dkim tls backups && chmod 700 secrets
sudo chown -R 1000:1000 secrets/dkim      # the containers run as uid 1000 (node)
```

## 2. Start

```sh
docker compose up -d --build
docker compose ps                         # all healthy; "migrate" exited 0
curl -s http://127.0.0.1:3100/health      # {"status":"ok"}
```

## 3. Sender domain, then apps

```sh
./mailctl domain add notify.example.com --ip <PUBLIC_IP> --bounce-domain bounces.notify.example.com \
  --mail-host mail.notify.example.com
# publish the printed DNS records, ask the IP owner for the PTR record, wait for DNS, then:
./mailctl domain verify notify.example.com --ip <PUBLIC_IP>

./mailctl create-app "Eclipse Labs" exam-platform      exam      exams@notify.example.com
./mailctl create-app "Eclipse Labs" placement-platform placement placements@notify.example.com
./mailctl create-app "Eclipse Labs" alumni-platform    alumni    alumni@notify.example.com
# each prints its API key once; store it in that application's secret store
```

Keys: `./mailctl keys create|list "<tenant>" <app>`, `./mailctl keys revoke <prefix>`.
During warm-up, lock an app to test mailboxes: `./mailctl set-recipients "<tenant>" <app> a@gmail.com @college.edu`.
Every admin command is recorded in `admin_audit_log` with `ADMIN_ACTOR` (default: your login name).

## 4. Cloudflare Tunnel (not changed by this repo)

Add a public hostname to the existing tunnel that points to the API, e.g. in `config.yml`:

```yaml
ingress:
  - hostname: mail-api.example.com
    service: http://127.0.0.1:3100
  # ... existing rules ...
```

Set `PUBLIC_BASE_URL=https://mail-api.example.com` (used in unsubscribe links). Consider a
Cloudflare Access policy or WAF rule that allows only your application servers on `/v1/*`; `/u/*`
(unsubscribe) must stay public.

## 5. Monitoring and alerts

- **Health:** container health checks (API `/health`; worker/tracker heartbeats; `postfix status`).
  `docker compose ps` shows them; `restart: unless-stopped` restarts crashed services.
- **Alerts:** the tracker checks every minute. It flags OTP queue age > 2 min, a stale worker or
  tracker heartbeat, mail stuck at Postfix > 30 min, bounce/failure rate > 10%, policy rejections,
  abnormal per-app volume, the tracker falling behind, and disk < 10% free. Alerts are logged
  (`docker compose logs tracker | grep ALERT`) and sent to `ALERT_WEBHOOK_URL` if set (Slack,
  Discord, Mattermost), at most once per 30 minutes each.
- **Metrics:** `curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3100/metrics`
  (Prometheus format): queue depth and age per lane, mail at Postfix, tracker lag, heartbeats,
  per-app status counts.
- **Postfix queue:** `docker compose exec postfix postqueue -p`; flush with `postqueue -f`.
- **Logs:** JSON logs, rotated by Docker (10 MB × 5 per service). Rotate Postfix's mail log weekly:
  `0 4 * * 0 cd /opt/eclipse-mail/deploy && docker compose exec -T postfix postfix logrotate`
  (the tracker finishes the old file before switching).

## 6. Backups (off-machine)

```sh
openssl rand -base64 36 > secrets/backup-passphrase && chmod 600 secrets/backup-passphrase
# keep a copy of the passphrase OFF this server (password manager); without it backups are useless
rclone config                              # e.g. Google Drive, another server via SFTP, R2/S3
crontab -e
# 30 2 * * * cd /opt/eclipse-mail/deploy && BACKUP_REMOTE=gdrive:eclipse-mail ./backup.sh >> backups/backup.log 2>&1
```

A backup contains the database dump, the DKIM private keys and `.env`, encrypted with the
passphrase (AES-256, PBKDF2). Restore: `./restore.sh backups/<file>`. It restores the database and
DKIM keys (and `.env` on a fresh machine), then restarts the services. **Test a restore on a spare
machine every few months.**

## 7. Upgrades and rollback

```sh
./backup.sh                                # always first
git fetch && git log --oneline HEAD..origin/main
git checkout <new commit>
docker compose build && docker compose up -d   # migrate runs first, then the services restart
```

- Queued mail is safe during restarts: it lives in Postgres (worker queue) and the `postfix-spool`
  volume (Postfix queue). Stopping the worker lets in-flight hand-offs finish (60 s grace).
- **Rollback:** `git checkout <previous commit> && docker compose build && docker compose up -d`.
  Migrations are forward-only. A rollback that crosses a migration with a breaking change (e.g.
  `006_status_model.sql` renames a status) needs `./restore.sh` of the pre-upgrade backup. Messages
  accepted after that backup are then lost from the database (Postfix still delivers what it holds).
- Never `docker compose down -v` in production: `-v` deletes the database and the Postfix queue.

## 8. Recovery procedures

| Situation | Action |
| --- | --- |
| Server rebooted / power loss | Services start by themselves; queued and in-flight mail resumes. Check `docker compose ps` and the alerts. |
| Internet down | Postfix and the worker keep retrying; mail resumes when the link returns. Postfix gives up after `POSTFIX_MAX_QUEUE_LIFETIME`. |
| Port 25 blocked suddenly | `mta_backlog` alert; `postqueue -p` shows "Connection timed out". Fix the network; mail is kept until the queue lifetime. |
| IP blocklisted / policy rejections | `policy_rejections` alert. Pause bulk mail (`BULK_RATE_PER_SECOND=0.1`, restart worker), find the cause, request delisting. |
| A leaked API key | `./mailctl keys revoke <prefix>`; issue a new one; check `admin_audit_log` and that app's volume. |
| Disk full | `disk_*` alert. Prune old Docker images/logs; check `postqueue -p` for a stuck queue. |
| Server lost | New server → steps 1–2 → `./restore.sh <latest backup>` → update DNS A/PTR if the IP changed → re-run `preflight.sh`. |
