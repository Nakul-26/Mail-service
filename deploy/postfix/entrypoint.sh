#!/bin/sh
# Configures Postfix as an outbound-only MTA for the mail service, then runs it in the foreground.
set -eu

: "${POSTFIX_HOSTNAME:?POSTFIX_HOSTNAME is required (the EHLO name; must match the server IP's PTR record)}"
: "${POSTFIX_MYNETWORKS:?POSTFIX_MYNETWORKS is required (the internal Docker subnet allowed to submit)}"
: "${POSTFIX_BOUNCE_DOMAINS:?POSTFIX_BOUNCE_DOMAINS is required (VERP return-path domains, comma separated)}"
BOUNCE_TRANSPORT="${POSTFIX_BOUNCE_TRANSPORT:-smtp:[tracker]:2525}"

pc() { postconf -e "$@"; }

# Debian's "No configuration" install ships no main.cf; start from an empty one each boot so the
# environment is the only source of settings.
: > /etc/postfix/main.cf
pc "compatibility_level = 3.6" "biff = no" "append_dot_mydomain = no" "readme_directory = no"

# Identity. The EHLO name, the server IP's PTR record and its A record must all agree.
pc "myhostname = ${POSTFIX_HOSTNAME}" "myorigin = \$myhostname" "smtpd_banner = \$myhostname ESMTP"
pc "inet_interfaces = all" "inet_protocols = ${POSTFIX_INET_PROTOCOLS:-ipv4}"
pc "mydestination =" "local_recipient_maps =" "local_transport = error:5.1.1 local delivery is disabled"
pc "alias_maps =" "alias_database ="

# Not an open relay: only the internal network may send to the internet. From outside, Postfix
# accepts mail only for the bounce domains, which it hands to the tracker's bounce receiver.
pc "mynetworks = 127.0.0.0/8 ${POSTFIX_MYNETWORKS}"
pc "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination"
pc "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination"
pc "smtpd_helo_required = yes" "disable_vrfy_command = yes" "smtpd_client_connection_rate_limit = 30"
domains=$(echo "$POSTFIX_BOUNCE_DOMAINS" | tr ',' ' ')
pc "relay_domains = ${domains}" "relay_recipient_maps ="
: > /etc/postfix/transport
for d in $domains; do echo "$d ${BOUNCE_TRANSPORT}" >> /etc/postfix/transport; done
pc "transport_maps = hash:/etc/postfix/transport"
postmap /etc/postfix/transport

# Outbound TLS whenever the receiving server offers it; verify nothing (opportunistic, RFC 7435).
pc "smtp_tls_security_level = may" "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt" \
   "smtp_tls_loglevel = 1" "smtp_tls_session_cache_database = btree:\${data_directory}/smtp_scache"
# Inbound TLS (bounces arriving on port 25) if a certificate for POSTFIX_HOSTNAME is mounted.
if [ -s /etc/postfix/tls/fullchain.pem ] && [ -s /etc/postfix/tls/privkey.pem ]; then
  pc "smtpd_tls_security_level = may" "smtpd_tls_chain_files = /etc/postfix/tls/privkey.pem, /etc/postfix/tls/fullchain.pem" \
     "smtpd_tls_loglevel = 1"
else
  pc "smtpd_tls_security_level = none"
fi

# Queue, retries and per-destination throttling (Gmail, Outlook, etc. are each a destination).
pc "enable_long_queue_ids = yes"
pc "maximal_queue_lifetime = ${POSTFIX_MAX_QUEUE_LIFETIME:-1d}" "bounce_queue_lifetime = ${POSTFIX_MAX_QUEUE_LIFETIME:-1d}"
pc "minimal_backoff_time = 300s" "maximal_backoff_time = 1800s"
pc "default_destination_concurrency_limit = ${POSTFIX_DESTINATION_CONCURRENCY:-5}"
pc "smtp_destination_rate_delay = ${POSTFIX_DESTINATION_RATE_DELAY:-0s}"
pc "message_size_limit = 10485760" "notify_classes = resource, software"

# Log to a file the tracker reads (shared volume).
pc "maillog_file = /var/log/postfix/maillog"

# TEST ONLY: send everything to a fake receiving server instead of real MX hosts.
if [ -n "${POSTFIX_TEST_RELAYHOST:-}" ]; then
  echo "WARNING: POSTFIX_TEST_RELAYHOST=${POSTFIX_TEST_RELAYHOST}: mail is NOT delivered to real recipients" >&2
  pc "relayhost = ${POSTFIX_TEST_RELAYHOST}" "smtp_tls_security_level = none"
else
  pc "relayhost ="
fi

# Containers don't need Postfix's chroot (and it breaks DNS lookups without extra copying).
postconf -F '*/*/chroot = n'
grep -q '^postlog' /etc/postfix/master.cf || \
  echo 'postlog   unix-dgram n  -       n       -       1       postlogd' >> /etc/postfix/master.cf

touch /var/log/postfix/maillog && chmod 0644 /var/log/postfix/maillog
postfix check
echo "postfix: ${POSTFIX_HOSTNAME}, submissions from ${POSTFIX_MYNETWORKS}, bounce domains: ${domains}" >&2
exec postfix start-fg
