#!/usr/bin/env bash
set -euo pipefail

DB_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/bot}"

echo "Applying schema to ${DB_URL}..."
psql "$DB_URL" -f "$(dirname "$0")/schema.sql"
echo "Schema applied successfully."
