#!/usr/bin/env bash
set -euo pipefail

# Try to load .env from project root if POSTGRES_URL is not set
if [ -z "${POSTGRES_URL:-}" ] && [ -f "../../.env" ]; then
    export $(grep -v '^#' ../../.env | xargs)
fi

DB_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/bot}"

echo "Applying schema to ${DB_URL}..."
psql "$DB_URL" -f "$(dirname "$0")/schema.sql"
echo "Schema applied successfully."
