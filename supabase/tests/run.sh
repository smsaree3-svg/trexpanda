#!/usr/bin/env bash
# Runs the RLS regression tests against a THROWAWAY database on a LOCAL Postgres (15+).
# Usage:  PGHOST=/var/run/postgresql PGUSER=postgres supabase/tests/run.sh
# It creates a temporary database, loads the schema and tests, then drops it.
# It refuses to run against anything that looks like a hosted Supabase project.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"

case "${PGHOST:-localhost}" in
  *supabase.co*|*supabase.com*|*pooler*) echo "Refusing: PGHOST points at a hosted project. Use a local Postgres." >&2; exit 2 ;;
esac

db="trexpanda_rls_test_$$"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database $db" >/dev/null
trap 'psql -X -q -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true' EXIT

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$1" >/dev/null 2>&1 || { echo "FAILED loading $1" >&2; psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$1" >&2; exit 1; }; }
run "$here/00_supabase_stub.sql"
run "$root/schema.sql"
run "$root/billing.sql"
run "$root/migrations/20261017_security_hardening.sql"
run "$root/migrations/20261017_security_hardening.sql"   # idempotency: must apply twice
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$here/rls_test.sql" 2>&1 | grep -E "ok:|FAIL|PASSED|ERROR"
