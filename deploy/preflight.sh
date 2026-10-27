#!/usr/bin/env bash
# Can this server deliver mail directly? Run it ON the production server before going live:
#   ./preflight.sh mail.notify.example.com
# Read-only: it changes nothing. Every FAIL is a blocker for direct delivery; see
# docs/deliverability.md for what each one means and who can fix it.
set -u
host="${1:?usage: ./preflight.sh <POSTFIX_HOSTNAME>}"
fail=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; fail=1; }
warn() { echo "WARN  $*"; }

pub=$(curl -4 -s --max-time 10 https://api.ipify.org || true)
[ -n "$pub" ] && ok "public IPv4 seen by the internet: $pub" || bad "could not determine the public IPv4 (no internet access?)"

# Behind NAT/CGNAT? Compare with the addresses on this machine.
if ip -4 addr 2>/dev/null | grep -q "inet $pub/"; then
  ok "the public IP is on this machine (no NAT)"
else
  warn "the public IP is not on this machine: traffic is NATed. Fine only if the IP is dedicated to this server, NOT shared with the whole campus"
  case "$pub" in 100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) bad "$pub is in the CGNAT range (100.64.0.0/10): no PTR possible, direct delivery impossible";; esac
fi

# Outbound port 25 to major providers.
for mx in gmail-smtp-in.l.google.com outlook-com.olc.protection.outlook.com mta5.am0.yahoodns.net; do
  if timeout 8 bash -c "exec 3<>/dev/tcp/$mx/25" 2>/dev/null || nc -z -w 8 "$mx" 25 2>/dev/null; then
    ok "outbound port 25 to $mx"
  else
    bad "outbound port 25 to $mx is blocked (college firewall or ISP)"
  fi
done

# Forward and reverse DNS must agree with the EHLO name.
a=$(dig +short A "$host" | tail -1)
[ "$a" = "$pub" ] && ok "A $host -> $a" || bad "A record of $host is '${a:-missing}', expected $pub"
ptr=$(dig +short -x "$pub" | sed 's/\.$//')
[ "$ptr" = "$host" ] && ok "PTR $pub -> $ptr" || bad "PTR of $pub is '${ptr:-missing}', expected $host (set by whoever owns the IP: college network team / ISP)"

# Blocklists (queried via DNS; public resolvers are often refused by Spamhaus, so a "no answer" is not proof).
rev=$(echo "$pub" | awk -F. '{print $4"."$3"."$2"."$1}')
for bl in zen.spamhaus.org b.barracudacentral.org bl.spamcop.net; do
  r=$(dig +short "$rev.$bl" A | head -1)
  case "$r" in
    127.255.255.*) warn "$bl refused the query (use a local resolver or check https://check.spamhaus.org/ by hand)";;
    127.*) bad "$pub is listed on $bl ($r)";;
    *) ok "not listed on $bl";;
  esac
done

echo
[ $fail -eq 0 ] && echo "No blockers found. Next: DNS records (./mailctl domain add/verify), then the warm-up plan." \
               || echo "Direct delivery is NOT ready. Do not send real mail from this server yet."
exit $fail
