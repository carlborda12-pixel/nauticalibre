#!/usr/bin/env bash
# Levanta Postgres de prueba + Supabase falso + Edge Functions + panel, para pruebas de punta a punta.
set -e
cd "$(dirname "$0")/.."
DB=nautica_e2e
psql -h /tmp/pg -p 54329 -U postgres -qc "drop database if exists $DB" -c "create database $DB" >/dev/null
psql -h /tmp/pg -p 54329 -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f test/bootstrap.sql \
  -f supabase/migrations/20261115000001_esquema.sql -f supabase/migrations/20261115000002_catalogo.sql >/dev/null 2>&1
psql -h /tmp/pg -p 54329 -U postgres -d $DB -qc "alter table auth.users add column if not exists pass text, add column if not exists meta jsonb default '{}'" >/dev/null
