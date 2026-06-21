#!/usr/bin/env bash
# Sets up the local PostgreSQL cluster, user, database, and pgvector for CLOVENT dev.
set -e

BREW_PREFIX="$HOME/homebrew"
PG_BIN="$BREW_PREFIX/opt/postgresql@16/bin"
PG_DATA="$HOME/.clovent/pgdata"
PG_LOG="$HOME/.clovent/postgres.log"
PG_PORT=5432

export PATH="$PG_BIN:$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$PATH"

mkdir -p "$HOME/.clovent"

echo "==> Checking PostgreSQL..."
if ! "$PG_BIN/pg_ctl" status -D "$PG_DATA" >/dev/null 2>&1; then
  if [ ! -d "$PG_DATA" ]; then
    echo "==> Initializing PostgreSQL cluster at $PG_DATA"
    "$PG_BIN/initdb" --pgdata="$PG_DATA" --auth=trust --username=clovent --encoding=UTF8 --locale=C
  fi

  echo "==> Starting PostgreSQL..."
  "$PG_BIN/pg_ctl" start -D "$PG_DATA" -l "$PG_LOG" -o "-p $PG_PORT" -w
  sleep 2
else
  echo "==> PostgreSQL already running"
fi

echo "==> Creating database and user..."
"$PG_BIN/psql" -U clovent -p $PG_PORT -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='clovent'" | grep -q 1 \
  || "$PG_BIN/createdb" -U clovent -p $PG_PORT clovent

echo "==> Installing pgvector extension..."
# Build pgvector if not already installed
if ! "$PG_BIN/psql" -U clovent -p $PG_PORT -d clovent -c "CREATE EXTENSION IF NOT EXISTS vector" 2>/dev/null; then
  echo "==> pgvector not installed — building from source..."
  TMPDIR=$(mktemp -d)
  cd "$TMPDIR"
  curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.0.tar.gz" | tar xz --strip-components 1
  PG_CONFIG="$PG_BIN/pg_config" make
  PG_CONFIG="$PG_BIN/pg_config" make install
  cd -
  rm -rf "$TMPDIR"
  "$PG_BIN/psql" -U clovent -p $PG_PORT -d clovent -c "CREATE EXTENSION IF NOT EXISTS vector"
fi

echo "==> Running schema migration..."
"$PG_BIN/psql" -U clovent -p $PG_PORT -d clovent -f "$(dirname "$0")/../backend/src/db/migrations/001_initial.sql"

echo ""
echo "✅ Database ready!"
echo "   Connection: postgresql://clovent@localhost:5432/clovent"
