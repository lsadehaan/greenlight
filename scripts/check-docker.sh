#!/usr/bin/env bash
# Verify Docker image size and startup time
# Usage: ./scripts/check-docker.sh
set -euo pipefail

IMAGE_NAME="${1:-greenlight}"
MAX_SIZE_MB=200
MAX_STARTUP_SECONDS=5

echo "=== Docker Image Size Check ==="
docker build -t "$IMAGE_NAME" .
SIZE_BYTES=$(docker image inspect "$IMAGE_NAME" --format='{{.Size}}')
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
echo "Image size: ${SIZE_MB}MB (limit: ${MAX_SIZE_MB}MB)"
if [ "$SIZE_MB" -gt "$MAX_SIZE_MB" ]; then
  echo "FAIL: Image exceeds ${MAX_SIZE_MB}MB"
  exit 1
fi
echo "PASS"
echo ""

echo "=== Startup Time Check ==="
# Start fresh containers
docker compose down -v 2>/dev/null || true
docker compose up -d postgres redis
echo "Waiting for dependencies..."
sleep 5

# Run migrations
docker compose run --rm app npx prisma migrate deploy 2>/dev/null || true

# Measure startup time
START_TIME=$(date +%s%N)
docker compose up -d app

# Poll health endpoint
DEADLINE=$(($(date +%s) + MAX_STARTUP_SECONDS))
HEALTHY=false
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 0.2
done

END_TIME=$(date +%s%N)
ELAPSED_MS=$(( (END_TIME - START_TIME) / 1000000 ))
ELAPSED_S=$(echo "scale=2; $ELAPSED_MS / 1000" | bc)

if [ "$HEALTHY" = true ]; then
  echo "Startup time: ${ELAPSED_S}s (limit: ${MAX_STARTUP_SECONDS}s)"
  if [ "$ELAPSED_MS" -gt $((MAX_STARTUP_SECONDS * 1000)) ]; then
    echo "FAIL: Startup exceeded ${MAX_STARTUP_SECONDS}s"
    exit 1
  fi
  echo "PASS"
else
  echo "FAIL: Health check did not return 200 within ${MAX_STARTUP_SECONDS}s"
  exit 1
fi
