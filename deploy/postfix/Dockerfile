# Outbound MTA for the self-hosted route. Configured entirely from environment variables by
# entrypoint.sh; see docs/deployment.md for the settings.
FROM debian:bookworm-slim

RUN echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      postfix ca-certificates netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/log/postfix

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

EXPOSE 25
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD postfix status >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
