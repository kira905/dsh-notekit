# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.1.0] - 2026-10-19

### Added

- **`apply-note.mjs`** — anchor-based note insertion: plan file (`mark` / `targets` /
  `anchor.mode` / `insert` / `note`), dry-run by default, `--only`, `--manifest-out`,
  `--before-dir`, `--json`, `--help`.
- **`restore-note.mjs`** — LIFO byte-exact rollback from the manifest, line-block replacement,
  idempotent re-runs, `--target`, `--expect-file-sha`, `--help`.
- **`lib/notekit.mjs`** — core library: plan validation, anchor location (prefix / contains /
  exact / block), idempotency guard, transactional application, byte-slice splicing,
  LIFO restore.
- **`selftest.mjs`** — 66 assertions covering positive cases, 8 must-fail cases, rollback
  semantics and the "`--help` must not act" discipline.
- **`drill.mjs`** — 11-stage fixture-tree drill (28 assertions) with optional read-only
  before/after sha evidence files.
- **`plans/example.json`** — runnable example plan.
- `package.json` with `bin` entries, AGPL-3.0 + commercial dual licensing.

### Changed (relative to the private source tree)

- Fixture roots now live under the **system temp directory** (`os.tmpdir()`), not a
  machine-absolute `_tmp` path; the delete guard checks "temp-dir prefix + `dsh-notekit-` name
  prefix" instead of a hard-coded drive path.
- `drill.mjs` no longer hard-codes a private document list for its read-only evidence step:
  pass paths as **command-line arguments** (no arguments = touch nothing external).
- Usage comments and the example plan use generic placeholders instead of machine paths.
