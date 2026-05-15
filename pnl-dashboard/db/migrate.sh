#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root regardless of where this script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Load .env from repo root if POSTGRES_URL is not already set in env.
if [ -z "${POSTGRES_URL:-}" ] && [ -f "${REPO_ROOT}/.env" ]; then
    # shellcheck disable=SC2046
    export $(grep -E '^[A-Z_]+=' "${REPO_ROOT}/.env" | grep -v '^#' | xargs)
fi

DB_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5434/bot}"

echo "Applying schema to ${DB_URL}..."
psql "${DB_URL}" -f "${SCRIPT_DIR}/schema.sql"

# Apply any incremental migrations in order. Idempotent — files use IF NOT EXISTS.
if compgen -G "${SCRIPT_DIR}/migrations/*.sql" > /dev/null; then
    for f in "${SCRIPT_DIR}"/migrations/*.sql; do
        echo "Applying migration: $(basename "$f")"
        psql "${DB_URL}" -f "$f"
    done
fi

echo "Schema applied successfully."
