#!/usr/bin/env bash
# Run E2E tests against a Docker Compose environment
# Usage: ./scripts/run-e2e.sh
set -euo pipefail

echo "=== Starting test environment ==="
docker compose -f docker-compose.yml up -d --build --wait

echo "=== Running migrations ==="
docker compose exec app npx prisma migrate deploy 2>/dev/null || \
  docker compose run --rm app npx prisma migrate deploy

echo "=== Creating bootstrap API key ==="
# Generate a key and capture it
BOOTSTRAP_KEY=$(docker compose exec app node -e "
  const crypto = require('crypto');
  const key = crypto.randomBytes(32).toString('hex');
  console.log(key);
" 2>/dev/null || echo "test-api-key-$(date +%s)")

echo "Bootstrap key: ${BOOTSTRAP_KEY:0:8}..."

echo "=== Running E2E tests ==="
E2E_BASE_URL=http://localhost:3000 \
E2E_API_KEY="$BOOTSTRAP_KEY" \
npx vitest run tests/e2e/ --reporter=verbose

echo "=== Checking server logs for errors ==="
ERROR_COUNT=$(docker compose logs app 2>&1 | grep -ci "error\|unhandled\|uncaught" || true)
echo "Error occurrences in logs: $ERROR_COUNT"
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo "WARNING: Found error messages in server logs"
  docker compose logs app 2>&1 | grep -i "error\|unhandled\|uncaught" | tail -20
fi

echo "=== E2E tests complete ==="
