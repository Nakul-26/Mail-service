#!/bin/sh
# Restores a backup made by backup.sh:  ./restore.sh backups/eclipse-mail-<stamp>.tar.gz.enc
# Replaces the current database. Stop the worker first so nothing is sent mid-restore.
# Test this regularly on a spare machine: a backup that was never restored is not a backup.
set -eu
cd "$(dirname "$0")"
# COMPOSE_ARGS / ENV_FILE let the same script work against a non-default stack (e.g. the e2e test).
ENV_FILE="${ENV_FILE:-.env}"
dc() { docker compose ${COMPOSE_ARGS:-} "$@"; }
file="${1:?usage: ./restore.sh <backup file>}"
: "${BACKUP_PASSPHRASE_FILE:=./secrets/backup-passphrase}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$file" | tar -C "$work" -xzf -
tar -C "$work" -xf "$work/secrets.tar"
mkdir -p "${SECRETS_DIR:-./secrets}"
cp -R "$work/${SECRETS_DIR:-./secrets}/dkim" "${SECRETS_DIR:-./secrets}/"
if [ ! -f "$ENV_FILE" ]; then
  cp "$work/env" "$ENV_FILE" && chmod 600 "$ENV_FILE"   # fresh machine: restore the settings too
  echo "restored $ENV_FILE and DKIM keys"
else
  echo "restored DKIM keys (kept the existing $ENV_FILE)"
fi

dc stop worker tracker api 2>/dev/null || true
dc up -d --wait postgres
dc exec -T postgres pg_restore -U mail -d mail --clean --if-exists --no-owner < "$work/mail.pgdump"
echo "database restored; starting services"
dc up -d
# Messages that were at Postfix when the backup was taken are accepted_local/mta_deferred.
# If the old machine's Postfix queue was lost, list them and decide whether to re-send:
echo "Messages possibly lost with the old Postfix queue:"
dc exec -T postgres psql -U mail -d mail -c \
  "SELECT count(*), min(sent_at) FROM messages WHERE status IN ('accepted_local','mta_deferred')"
