#!/bin/sh
# Backs up everything needed to rebuild the service on another machine:
#   - PostgreSQL (messages, events, suppressions, apps, hashed keys, audit log)   pg_dump, custom format
#   - DKIM private keys (deploy/secrets/dkim) and deploy/.env                     tar
# The archive is encrypted with a passphrase (BACKUP_PASSPHRASE_FILE) because it contains secrets,
# then copied off the machine with rclone (BACKUP_REMOTE, e.g. "gdrive:eclipse-mail" or
# "sftp-backup:/srv/backups") if set. Keeps the newest 14 local copies.
#
# Cron (daily 02:30):  30 2 * * *  cd /opt/eclipse-mail/deploy && ./backup.sh >> backups/backup.log 2>&1
#
# Not backed up: the Postfix queue (messages Postfix still holds). Its contents are also in the
# database as accepted_local/mta_deferred and can be re-sent if the machine is lost.
set -eu
cd "$(dirname "$0")"
# COMPOSE_ARGS / ENV_FILE let the same script work against a non-default stack (e.g. the e2e test).
ENV_FILE="${ENV_FILE:-.env}"
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
: "${BACKUP_PASSPHRASE_FILE:=./secrets/backup-passphrase}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "missing $BACKUP_PASSPHRASE_FILE (create it: openssl rand -base64 36 > $BACKUP_PASSPHRASE_FILE; chmod 600; store a copy OFF this machine)" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

dc exec -T postgres pg_dump -U mail -d mail --format=custom > "$work/mail.pgdump"
cp "$ENV_FILE" "$work/env"
tar -C . -cf "$work/secrets.tar" "${SECRETS_DIR:-./secrets}/dkim"
tar -C "$work" -rf "$work/secrets.tar" env
tar -C "$work" -czf - mail.pgdump secrets.tar \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" \
  > "backups/eclipse-mail-$stamp.tar.gz.enc"
chmod 600 "backups/eclipse-mail-$stamp.tar.gz.enc"
echo "backup written: backups/eclipse-mail-$stamp.tar.gz.enc ($(du -h "backups/eclipse-mail-$stamp.tar.gz.enc" | cut -f1))"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "backups/eclipse-mail-$stamp.tar.gz.enc" "$BACKUP_REMOTE" && echo "copied to $BACKUP_REMOTE"
else
  echo "WARNING: BACKUP_REMOTE not set; the backup exists only on this machine" >&2
fi
ls -1t backups/eclipse-mail-*.tar.gz.enc | tail -n +15 | xargs -r rm -f
