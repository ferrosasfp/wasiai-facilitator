#!/usr/bin/env bash
# ============================================================================
# wasiai-facilitator — Smoke Test Script
# Validates core endpoints post-deploy.
# Usage: ./scripts/smoke-test.sh [BASE_URL]
# Default: http://localhost:3002
# ============================================================================

set -euo pipefail

BASE_URL="${1:-http://localhost:3002}"
BASE_URL="${BASE_URL%/}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local status="$2"
  local code="$3"
  if [ "$status" = "PASS" ]; then
    echo "  PASS  [$code] $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  [$code] $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo " wasiai-facilitator Smoke Test"
echo " Target: $BASE_URL"
echo "============================================"
echo ""

# GET /health
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
[ "$CODE" = "200" ] && check "GET /health" PASS "$CODE" || check "GET /health" FAIL "$CODE"

# GET /supported
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/supported")
[ "$CODE" = "200" ] && check "GET /supported" PASS "$CODE" || check "GET /supported" FAIL "$CODE"

# POST /verify (empty body → expect 400 validation error)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/verify" \
  -H "Content-Type: application/json" -d '{}')
[ "$CODE" = "400" ] && check "POST /verify (empty → 400)" PASS "$CODE" || check "POST /verify (empty → 400)" FAIL "$CODE"

# POST /settle (empty body → expect 400 validation error)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/settle" \
  -H "Content-Type: application/json" -d '{}')
[ "$CODE" = "400" ] && check "POST /settle (empty → 400)" PASS "$CODE" || check "POST /settle (empty → 400)" FAIL "$CODE"

# GET /metrics
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/metrics")
[ "$CODE" = "200" ] && check "GET /metrics" PASS "$CODE" || check "GET /metrics" FAIL "$CODE"

echo ""
echo "============================================"
echo " Results: $PASS PASS / $FAIL FAIL"
echo "============================================"

[ $FAIL -gt 0 ] && exit 1 || exit 0
