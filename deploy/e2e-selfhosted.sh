#!/usr/bin/env bash
# End-to-end acceptance test of the self-hosted stack, entirely on this machine:
# the real API, worker, tracker and Postfix (DKIM, VERP, queue), with fake-mx standing in for
# recipients' servers. No AWS/SES credentials, and nothing is delivered to the internet.
#   ./e2e-selfhosted.sh          (KEEP=1 leaves the stack running afterwards)
# SIMULATED: the remote servers (fake-mx) and DNS (the sender domain is marked verified directly).
set -euo pipefail
cd "$(dirname "$0")"

export ENV_FILE=.env.e2e SECRETS_DIR=./.e2e-secrets COMPOSE_PROJECT_NAME=eclipse-mail-e2e
API=http://127.0.0.1:3190
MX=http://127.0.0.1:8091
secret() { node -e "console.log(require('crypto').randomBytes(30).toString('base64url'))"; }
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=$(secret)
UNSUBSCRIBE_SECRET=$(secret)
BOUNCE_SECRET=$(secret)
METRICS_TOKEN=$(secret)
POSTFIX_HOSTNAME=mail.notify.e2e.example
BOUNCE_DOMAIN=bounces.notify.e2e.example
PUBLIC_BASE_URL=$API
API_PORT=3190
FAKE_MX_HTTP_PORT=8091
BULK_RATE_PER_SECOND=40
WORKER_CONCURRENCY=10
EOF
mkdir -p "$SECRETS_DIR/dkim"
chmod 777 "$SECRETS_DIR/dkim" 2>/dev/null || true # the container's node user writes the key here

dc() { docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.test.yml "$@"; }
admin() { dc --profile admin run --rm -T -e ADMIN_ACTOR=e2e admin "$@"; }
sql() { dc exec -T postgres psql -U mail -d mail -tAc "$1"; }
json() { node -pe "const v=JSON.parse(require('fs').readFileSync(0,'utf8')); $1"; }
cleanup() { [ "${KEEP:-0}" = 1 ] || { dc down -v --remove-orphans >/dev/null 2>&1; rm -rf "$SECRETS_DIR" "$ENV_FILE"; }; }
trap cleanup EXIT

echo "== build and start (no AWS settings anywhere)"
grep -i -E 'ses|aws|sns' "$ENV_FILE" && { echo "unexpected SES/AWS setting"; exit 1; }
dc build -q
dc up -d postgres
dc up -d --wait api worker tracker postfix fake-mx

echo "== sender domain and apps"
admin dist/scripts/domain.js add notify.e2e.example --selector e2e --ip 203.0.113.10 --bounce-domain bounces.notify.e2e.example >/dev/null
sql "UPDATE sender_domains SET verified_at = now() WHERE domain = 'notify.e2e.example'" >/dev/null # SIMULATED: no real DNS here
key() { admin dist/scripts/create-app.js "E2E College" "$1" "$2" "$3" | tail -1; }
EXAM=$(key exam-portal exam exams@notify.e2e.example)
ALUMNI=$(key alumni-portal alumni alumni@notify.e2e.example)
send() { curl -s -H "Authorization: Bearer $1" -H 'content-type: application/json' -d "$2" "$API/$3"; }
otp() { send "$EXAM" "{\"to\":\"$1\",\"template\":\"exam-otp\",\"variables\":{\"name\":\"T\",\"otp\":\"123456\",\"expiresInMinutes\":5}}" v1/emails | json v.id; }

echo "== single messages: accepted, bounced, rejected, deferred, late bounce"
OK=$(otp ok@gmail.e2e.example); BOUNCE=$(otp bounce-me@gmail.e2e.example); REJECT=$(otp reject-me@outlook.e2e.example)
DEFER=$(otp defer-me@yahoo.e2e.example); LATE=$(otp async-bounce@college.e2e.example)

echo "== 300-recipient batch, an OTP sent during it, and a worker restart mid-batch"
recips=$(node -e "console.log(JSON.stringify(Array.from({length:300},(_,i)=>({to:'student'+i+'@college.e2e.example',variables:{name:'S'+i}}))))")
BATCH=$(send "$EXAM" "{\"template\":\"exam-instructions\",\"variables\":{\"examName\":\"DBMS\",\"startsAt\":\"10:00\",\"examUrl\":\"https://e.example\"},\"recipients\":$recips}" v1/batches | json v.id)
sleep 2
DURING=$(otp during-batch@gmail.e2e.example)
dc restart worker >/dev/null
NEWS=$(send "$ALUMNI" '{"to":"alum@gmail.e2e.example","template":"alumni-newsletter","variables":{"name":"P","title":"Reunion","message":"Hi"}}' v1/emails | json v.id)

st() { curl -s -H "Authorization: Bearer $EXAM" "$API/v1/emails/$1" | json v.status; }
echo "== waiting for outcomes"
for i in $(seq 1 90); do
  state=$(curl -s -H "Authorization: Bearer $EXAM" "$API/v1/batches/$BATCH" | json v.state)
  [ "$state" = completed ] && [ "$(st "$LATE")" = bounced ] && [ "$(st "$DEFER")" = mta_deferred ] && break
  sleep 2
done

fails=0
check() { local got; got=$(st "$2"); if [ "$got" = "$3" ]; then echo "PASS  $1: $got"; else echo "FAIL  $1: expected $3, got $got"; fails=$((fails+1)); fi; }
check "accepted by recipient server" "$OK" accepted_remote
check "unknown address (550 5.1.1)" "$BOUNCE" bounced
check "policy rejection (550 5.7.1)" "$REJECT" rejected
check "temporary failure, Postfix retrying" "$DEFER" mta_deferred
check "late bounce via DSN to VERP address" "$LATE" bounced
check "OTP during a batch" "$DURING" accepted_remote
NEWS_ST=$(curl -s -H "Authorization: Bearer $ALUMNI" "$API/v1/emails/$NEWS" | json v.status)
[ "$NEWS_ST" = accepted_remote ] && echo "PASS  newsletter: $NEWS_ST" || { echo "FAIL  newsletter: $NEWS_ST"; fails=$((fails+1)); }

summary=$(curl -s -H "Authorization: Bearer $EXAM" "$API/v1/batches/$BATCH")
echo "batch: $(echo "$summary" | json 'v.state+" "+JSON.stringify(v.counts)')"
[ "$(echo "$summary" | json 'v.counts.accepted_remote')" = 300 ] && echo "PASS  batch: 300/300 accepted after a worker restart" || { echo "FAIL  batch"; fails=$((fails+1)); }

supp=$(sql "SELECT string_agg(email || ':' || reason, ',' ORDER BY email) FROM suppressions")
echo "suppressions: $supp"
[[ "$supp" == *"bounce-me@gmail.e2e.example:hard_bounce"* && "$supp" == *"async-bounce@college.e2e.example:hard_bounce"* && "$supp" != *reject-me* ]] \
  && echo "PASS  bounces suppressed, policy rejection not suppressed" || { echo "FAIL  suppressions"; fails=$((fails+1)); }
again=$(otp bounce-me@gmail.e2e.example); sleep 1
[ "$(st "$again")" = suppressed ] && echo "PASS  next message to a bounced address is suppressed" || { echo "FAIL  repeat to bounced address"; fails=$((fails+1)); }

pos=$(curl -s "$MX/messages" | json "v.findIndex(m=>m.to.includes('during-batch@gmail.e2e.example'))")
echo "OTP sent during the batch arrived as message #$pos of $(curl -s "$MX/messages" | json v.length)"

echo "== DKIM signatures and return paths of everything fake-mx received"
pk=$(sql "SELECT dkim_public FROM sender_domains WHERE domain = 'notify.e2e.example'")
(cd .. && npx tsx scripts/dev/check-dkim.ts "$MX" notify.e2e.example e2e "$pk") || fails=$((fails+1))

echo "== Postfix is not an open relay (probe from the egress network, like an internet client)"
probe() {
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_egress" "${APP_IMAGE:-eclipse-mail-app:latest}" node -e "
const s=require('net').connect(25,'postfix');let i=0,buf='';
const cmds=['EHLO probe.example\r\n','MAIL FROM:<x@probe.example>\r\n','RCPT TO:<'+process.argv[1]+'>\r\n','QUIT\r\n'];
s.on('data',d=>{buf+=d;const lines=buf.split('\n');buf=lines.pop();for(const l of lines){if(/^\d{3} /.test(l)){if(i===3)console.log(l.trim());if(i<cmds.length)s.write(cmds[i++]);}}});
s.on('error',e=>console.log('error '+e.message));" "$1"
}
r1=$(probe victim@gmail.com)
[[ "$r1" == 554* || "$r1" == 454* ]] && echo "PASS  relay to an outside address refused: $r1" || { echo "FAIL  relay probe: $r1"; fails=$((fails+1)); }
r2=$(probe postmaster@bounces.notify.e2e.example)
[[ "$r2" == 250* ]] && echo "PASS  mail for the bounce domain accepted: $r2" || { echo "FAIL  bounce domain probe: $r2"; fails=$((fails+1)); }

echo "== metrics"
curl -s -H "Authorization: Bearer $(grep METRICS_TOKEN "$ENV_FILE" | cut -d= -f2)" "$API/metrics" | grep -E '^mail_(queue_depth|at_mta|tracker_pending|heartbeat)' || true

echo
[ $fails -eq 0 ] && echo "E2E PASSED (simulated recipients; no real external delivery was attempted)" || echo "E2E FAILED: $fails check(s)"
exit $fails
