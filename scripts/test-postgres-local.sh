#!/usr/bin/env bash
set -euo pipefail

port="${WAITLIST_PG_PORT:-55432}"
name="better-auth-waitlist-pg-$$"

docker run --rm -d --name "$name" \
  -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=better_auth \
  -p "127.0.0.1:${port}:5432" --tmpfs /var/lib/postgresql/data \
  postgres:16-alpine >/dev/null
trap 'docker stop "$name" >/dev/null' EXIT

for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U user -d better_auth >/dev/null 2>&1; then break; fi
  sleep 0.5
done
docker exec "$name" pg_isready -h 127.0.0.1 -U user -d better_auth >/dev/null

cd "$(dirname "$0")/.."
WAITLIST_TEST_DATABASE_URL="postgres://user:password@127.0.0.1:${port}/better_auth" pnpm run test:postgres "$@"
