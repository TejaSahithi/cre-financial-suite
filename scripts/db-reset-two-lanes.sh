#!/usr/bin/env bash
# P1.0 — production-parity local migration harness.
#
# The linked remote project (cjwdwuqqdokblakheyjb) deliberately does NOT have
# the six document_intelligence_v3 migrations applied (confirmed via
# `supabase migration list --linked` during the P0 audit — see
# docs/database/migration-repair.md's 2026-07-17 section). A plain
# `supabase db reset --local` applies every migration in this directory,
# including those six, so local tests would run against a schema richer
# than production unless this script's "remote-parity" lane is used.
#
# Usage:
#   scripts/db-reset-two-lanes.sh remote-parity   # authoritative P1 gate
#   scripts/db-reset-two-lanes.sh full-repository # confirm coexistence with the v3 scaffold
#   scripts/db-reset-two-lanes.sh both            # run remote-parity then full-repository

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
SET_ASIDE_DIR="$REPO_ROOT/.v3-scaffold-set-aside"

# A single mkdir is atomic even across concurrent processes/shells, unlike a
# plain "if [ -f lockfile ]" check -- this is the same shape of race that
# caused the parallel-process file-restoration incident during the real P0
# push (a second process observed the moved-aside files as an unexpected
# dirty-tree state). Portable choice over flock, which isn't guaranteed
# available in every git-bash/Windows environment this repo is used from.
LOCK_DIR="${TMPDIR:-/tmp}/cre-p1-db-reset.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another db-reset-two-lanes.sh run is already in progress ($LOCK_DIR exists)." >&2
  echo "If no other run is actually active, remove that directory and retry." >&2
  exit 1
fi
release_lock() { rmdir "$LOCK_DIR" 2>/dev/null || true; }

# The six migrations deliberately unapplied on the linked remote project.
# Keep this list in sync with docs/database/migration-repair.md's
# "six pending migrations" section if that set ever changes.
V3_SCAFFOLD_FILES=(
  20260819000000_document_intelligence_v3_scaffold.sql
  20260820000000_document_intelligence_v3_idempotency.sql
  20260820000001_phase5d_source_link_typed_source.sql
  20260821000000_document_intelligence_v3_run_profile_columns.sql
  20260822000000_document_intelligence_v3_layout_summary_column.sql
  20260823000000_document_intelligence_v3_package_graph.sql
)

set_aside() {
  echo "--- Setting aside the six document_intelligence_v3 migrations ---"
  mkdir -p "$SET_ASIDE_DIR"
  for f in "${V3_SCAFFOLD_FILES[@]}"; do
    if [ -f "$MIGRATIONS_DIR/$f" ]; then
      mv "$MIGRATIONS_DIR/$f" "$SET_ASIDE_DIR/$f"
    fi
  done
}

restore() {
  echo "--- Restoring the six document_intelligence_v3 migrations ---"
  for f in "${V3_SCAFFOLD_FILES[@]}"; do
    if [ -f "$SET_ASIDE_DIR/$f" ]; then
      mv "$SET_ASIDE_DIR/$f" "$MIGRATIONS_DIR/$f"
    fi
  done
  rmdir "$SET_ASIDE_DIR" 2>/dev/null || true
}

# Always attempt to restore on exit, even if a lane's test run fails --
# never leave the working tree missing tracked migration files. The lock
# must always release too, regardless of which path exits the script, so
# both live in one combined handler rather than two competing `trap ... EXIT`
# registrations (a second `trap EXIT` call replaces the first, it doesn't
# stack -- registering them separately would silently drop one).
cleanup_with_restore() { restore; release_lock; }
trap cleanup_with_restore EXIT

run_remote_parity_lane() {
  echo "=== Remote-parity lane (the authoritative P1 gate) ==="
  set_aside
  npx supabase db reset --local
  echo "Remote-parity schema is live. Run the P1 test suite now, e.g.:"
  echo "  deno test --allow-all supabase/functions/_tests/extraction-runs*.test.ts"
  echo "  npx vitest run src"
}

run_full_repository_lane() {
  echo "=== Full-repository lane (confirms coexistence with the v3 scaffold) ==="
  npx supabase db reset --local
  echo "Full-repository schema is live (includes the six v3-scaffold migrations)."
  echo "Run the same P1 test suite again to confirm no interaction effects."
}

case "${1:-}" in
  remote-parity)
    run_remote_parity_lane
    ;;
  full-repository)
    restore   # no-op if nothing was set aside; ensures a clean full state first
    trap release_lock EXIT   # restore already ran manually above; only the lock still needs releasing on exit
    run_full_repository_lane
    ;;
  both)
    run_remote_parity_lane
    restore
    trap release_lock EXIT   # restore already ran manually above; only the lock still needs releasing on exit
    run_full_repository_lane
    ;;
  *)
    echo "Usage: $0 {remote-parity|full-repository|both}" >&2
    exit 1
    ;;
esac
