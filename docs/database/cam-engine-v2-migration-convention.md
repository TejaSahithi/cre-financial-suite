# CAM Engine V2 migration numbering convention (the `202699` sequence)

## Background

This repository's migration filenames are timestamp-prefixed
(`YYYYMMDDHHMMSS_description.sql`) and, going into the CAM Engine V2 work
(Enterprise CAM & Budget Implementation Blueprint v1.0, Phases 1–3B), the
existing history already contained pre-existing "impossible calendar date"
prefixes from earlier work (e.g. `202604080146115`) — a known, pre-existing
issue, not something this convention created or is trying to fix
retroactively.

During Phase 3 development, session-generated migrations were twice created
with prefixes that read as genuine (but future) calendar dates relative to
the actual development date — first `202609xx` (September 2026), then a
"fixed" `202609xx` continuation that was still future-dated because it
inherited the same month. Both were caught and required a full renumbering
of every migration created in that session, because any fix that keeps a
`2026MM` prefix is inherently at risk of colliding with a real future
calendar month.

## The convention

Every CAM Engine V2 migration (Phases 1 through 3B) uses the prefix shape:

```
202699NNNNNNNN_description.sql
```

14 digits total — the same length as every other migration's
`YYYYMMDDHHMMSS` prefix, which matters: the `supabase` CLI's own
migration-list parser expects a 14-digit numeric prefix, so this series
keeps that exact width even though it is deliberately not a real
timestamp.

- **`2026`** — the real year development happened in (kept for rough
  chronological placement relative to the rest of the migration history).
- **`99`** — a deliberately impossible month. No calendar has a 99th month
  at any digit position, so this prefix can never be misread as a genuine
  past or future date, unlike `09` (September) or any other `01`–`12`
  value. This is the entire fix: the failure mode being defended against is
  "a human or a tool reads this filename as a real date," and `99` makes
  that reading impossible by construction rather than by convention alone.
- **`NNNNNNNN`** — a zero-padded, strictly monotonic 8-digit sequence
  number (`00000001`, `00000002`, …), unique across the whole `202699`
  series regardless of which phase or PR introduced it. As of this
  document, the series runs `20269900000001` through `20269900000022`
  (Phases 1–3B); the next migration in this family must use
  `20269900000023`.

## Rules

1. **Never reuse or renumber an already-applied/already-reported `202699`
   migration.** Once a `202699NNNNNN` migration has been applied to any
   shared environment (including local dev, once work built on top of it
   has been reported to a reviewer), its number is permanent. Fixes are new
   migrations, not edits to old filenames.
2. **New CAM Engine V2 migrations continue the same sequence** —
   `202699000023`, `202699000024`, etc. — rather than reverting to a
   calendar-date prefix. Do not mix a real calendar-date prefix into the
   same logical migration series.
3. **This convention is scoped to the CAM Engine V2 migration series.**
   It does not retroactively fix or relabel the pre-existing
   impossible-calendar-date migrations from before this work (e.g. the
   `202604080146xxx` family) — those are a separate, pre-existing, already
   -documented issue and out of scope for this series.
4. **The sequence number is the sole ordering signal.** Do not infer
   anything about calendar timing from the `2026` or `99` components beyond
   "this belongs to the CAM Engine V2 series" — use `git log`/commit
   history if you need to know when a specific migration was actually
   authored.

## CI validation

`scripts/check-cam-engine-v2-migration-convention.mjs` enforces:

- **Exact filename shape** — every `202699*` file matches
  `^202699\d{8}_[a-z0-9_]+\.sql$` exactly (14-digit prefix, no missing
  underscore, lowercase-and-digits-and-underscore description only).
- **Uniqueness** — no two files share the same `202699NNNNNNNN` prefix.
- **Contiguous sequence** — the sequence numbers form an unbroken run
  starting at `00000001` with no gaps (a gap usually means a migration was
  deleted or renumbered incorrectly, which this convention exists to
  prevent).
- **No calendar-plausible collision** — defensively re-asserts that no
  *other* migration file in the repository (any prefix) collides with a
  reserved `202699` value, and that no `202699` file could be misread as
  `YYYYMMDDHHMMSS` for a real date (the `99` month makes this
  structurally impossible, but the check asserts it explicitly rather than
  relying on that being obvious).

Run it locally with:

```sh
node scripts/check-cam-engine-v2-migration-convention.mjs
```

It exits non-zero on any violation, with a message identifying the exact
file and rule broken, so it can be wired into CI as a required check on
any PR that touches `supabase/migrations/`.

### What CI validation does *not* attempt in this pass

Two acceptance-gate items this script does not (and, from a static Node
script, cannot fully) verify are called out here rather than silently
assumed:

- **"Successful clean database reset"** — requires actually running
  `supabase db reset` (or an equivalent full migration replay) against a
  disposable Postgres instance, which is an infrastructure/CI-runner
  concern, not something a filename-level static check can validate. The
  migrations in this series have been applied and exercised via real
  `psql -f`/`docker exec` application and 250+ passing integration tests
  against the live local database (see the Phase 3B completion report),
  which is strong evidence of forward-application correctness — but that
  is not the same guarantee as a from-scratch clean reset, which should be
  added as its own CI job (`supabase db reset --local` in a fresh
  container) rather than folded into this script.
- **"Successful Supabase migration-list parsing"** — requires the
  `supabase` CLI itself (`supabase migration list`) to parse every
  filename in the repository without error, which depends on the installed
  CLI version's own parser, not just this repo's convention. This script's
  filename-shape check is a reasonable proxy (the CLI's own parser is
  stricter about the same `YYYYMMDDHHMMSS_description` shape), but running
  `supabase migration list` itself in CI is the authoritative check and
  should be added as a separate CI step alongside this script.
