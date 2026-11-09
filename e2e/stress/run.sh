#!/usr/bin/env bash
# Stress test of a running stack (`docker compose up --build -d --wait`, default limits).
#
# A "good" and a "bad" visitor run at the same time, each in its own container so nginx sees two
# different addresses. The bad one floods (with forged address headers, many sockets, a message
# burst); the good one behaves like a person. Passing means:
#   - the bad visitor is refused (429) and only a small, limited share gets through,
#   - the good visitor is never refused and stays fast,
#   - Redis holds a separate counter per visitor and none for nginx or the web server,
#   - both API instances shared the work,
#   - CPU is spread over the two instances and falls back to idle after the load,
#   - no 5xx anywhere, no container restarted, both APIs still ready.
# Needs the e2e dependencies installed (pnpm install --filter @kanban/e2e...).
set -euo pipefail
cd "$(dirname "$0")/../.."

SECONDS_RUN="${STRESS_SECONDS:-30}"
env_value() { grep "^$1=" .env | cut -d= -f2-; }
PASSWORD="$(env_value SEED_PASSWORD)"
ORIGIN="$(env_value APP_ORIGIN)"
REDIS_PASSWORD="$(env_value REDIS_PASSWORD)"

fail=0
problem() { echo "PROBLEM: $*"; fail=1; }

nginx_id="$(docker compose ps -q nginx)"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$nginx_id")"
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
service_ip() { ip_of "$(docker compose ps -q "$1")"; }

cleanup() {
  docker rm -f stress-good stress-bad >/dev/null 2>&1 || true
  [ -n "${sampler_pid:-}" ] && kill "$sampler_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# CPU samples of every container, every few seconds, for the whole run.
samples="$(mktemp)"
( while true; do
    now=$(date +%s)
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | sed "s/^/$now /" >> "$samples" || true
  done ) &
sampler_pid=$!

started_at="$(date -u +%Y-%m-%dT%H:%M:%S)"
load_started=$(date +%s)

start_visitor() { # name, email, role
  docker run -d --name "$1" --network "$network" -v "$PWD":/work:ro -w /work/e2e \
    -e TARGET=http://nginx:8080 -e ORIGIN="$ORIGIN" -e EMAIL="$2" -e PASSWORD="$PASSWORD" \
    -e SECONDS_RUN="$SECONDS_RUN" \
    node:22-alpine node --experimental-strip-types --no-warnings src/stress.ts "$3" >/dev/null
}
start_visitor stress-bad alice@example.com bad
start_visitor stress-good bob@example.com good
bad_ip="$(ip_of stress-bad)"
good_ip="$(ip_of stress-good)"
echo "bad visitor address: $bad_ip, good visitor address: $good_ip, running for ${SECONDS_RUN}s"

bad_code="$(docker wait stress-bad)"
good_code="$(docker wait stress-good)"
load_ended=$(date +%s)
echo "----- the bad visitor"; docker logs stress-bad 2>&1 | tail -n 20
echo "----- the good visitor"; docker logs stress-good 2>&1 | tail -n 20
[ "$bad_code" = "0" ] || problem "the bad visitor's own checks failed (exit $bad_code)"
[ "$good_code" = "0" ] || problem "the good visitor's own checks failed (exit $good_code)"

# ---- Redis: one counter per visitor, none for the web server or nginx -----------------------
redis() { docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning "$@"; }
keys="$(redis --scan --pattern 'rl:*')"
echo "----- limiter keys"; echo "$keys"
count_of() { redis get "$1" | tr -d '\r'; }
bad_count="$(count_of "rl:api:$bad_ip")"; good_count="$(count_of "rl:api:$good_ip")"
echo "API counter, bad: ${bad_count:-none}, good: ${good_count:-none}"
[ -n "$bad_count" ] && [ "$bad_count" -gt 300 ] || problem "the bad visitor's counter is missing or not above the limit"
[ -n "$good_count" ] && [ "$good_count" -lt 300 ] || problem "the good visitor's counter is missing or reached the limit"
for service in web nginx api1 api2; do
  if echo "$keys" | grep -q ":$(service_ip "$service")$"; then
    problem "visitors were counted against the address of $service (every visitor would share one limit)"
  fi
done

# ---- spread over the two API instances ---------------------------------------------------------
requests_of() { docker compose logs --no-color --since "${started_at}Z" "$1" 2>/dev/null | grep -c 'request\\"' || true; }
r1="$(requests_of api1)"; r2="$(requests_of api2)"
echo "requests handled, api1: $r1, api2: $r2"
total=$((r1 + r2))
if [ "$total" -lt 200 ]; then problem "too few requests reached the APIs ($total) to judge the spread"; else
  share=$((100 * (r1 < r2 ? r1 : r2) / total))
  echo "the smaller instance handled $share% of the requests"
  [ "$share" -ge 30 ] || problem "the load is not spread: one API instance handled only $share%"
fi
five_hundreds="$(docker compose logs --no-color --since "${started_at}Z" api1 api2 2>/dev/null | grep -c 'status\\":5' || true)"
[ "$five_hundreds" = "0" ] || problem "$five_hundreds requests were answered with a 5xx"

# ---- CPU ---------------------------------------------------------------------------------------
kill "$sampler_pid" >/dev/null 2>&1 || true; sampler_pid=""
# average CPU % per service while the load ran
cpu_avg() { awk -v s="$load_started" -v e="$load_ended" -v n="$1" \
  '$1>=s && $1<=e && $2 ~ n { gsub("%","",$3); sum+=$3; c++ } END { if (c) printf "%.0f", sum/c; else print 0 }' "$samples"; }
echo "----- average CPU during the load (percent of one core)"
for service in nginx web api1 api2 redis postgres worker; do echo "$service: $(cpu_avg "-$service-")"; done
c1="$(cpu_avg -api1-)"; c2="$(cpu_avg -api2-)"
if [ $((c1 + c2)) -ge 40 ]; then
  low=$((c1 < c2 ? c1 : c2)); high=$((c1 > c2 ? c1 : c2))
  [ $((low * 3)) -ge "$high" ] || problem "CPU is not spread: api1 $c1%, api2 $c2%"
fi
# after the load everything must calm down: nothing keeps spinning
idle=0
for _ in $(seq 1 20); do
  busy="$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | tr -d '%' | awk '$2 > 15 { print $1 " " $2 }')"
  if [ -z "$busy" ]; then idle=1; break; fi
  sleep 2
done
[ "$idle" = "1" ] || problem "still busy 40 s after the load ended: $busy"

# ---- the stack is still healthy ----------------------------------------------------------------
for api in api1 api2; do
  docker compose exec -T "$api" wget -qO /dev/null http://127.0.0.1:3001/ready || problem "$api is not ready after the load"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q "$api")")"
  [ "$restarts" = "0" ] || problem "$api restarted $restarts times"
done
for service in web worker nginx; do
  restarts="$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q "$service")")"
  [ "$restarts" = "0" ] || problem "$service restarted $restarts times"
done

if [ "$fail" = "0" ]; then echo "STRESS TEST PASSED"; else echo "STRESS TEST FAILED"; fi
exit "$fail"
