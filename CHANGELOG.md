# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Ticklers fired up to a full UTC offset early** ([#3](https://github.com/daveremy/tickler-mcp/issues/3)).
  `due` was stored exactly as supplied in a TEXT column, while `checkTicklers` compares it
  lexicographically against a UTC-Z `now`. A `due` carrying a numeric offset (or none at all) was
  therefore compared across two different frames of reference — in MST, a reminder set for 09:00
  local fired at 02:00. The error was always in the fire-early direction, which is why it read as
  working software.

### Added
- `normalizeDue()` — canonicalizes `due` to UTC-Z at every write path (`createTickler`,
  `snoozeTickler`, and the legacy JSON import), so lexicographic comparison is correct by
  construction. An unparseable `due` now throws a `RangeError` at write time instead of being
  stored as a string that mis-sorts silently forever.
- `normalizeStoredDueDates()` — rewrites rows already stored in a legacy format when the DB is
  opened. Idempotent and self-healing.
- The backfill now reports itself ([#6](https://github.com/daveremy/tickler-mcp/issues/6)). On the
  repair path it prints counts by stored shape before and after (`offset-suffixed`, non-canonical
  `utc`, `naive`, `unrecognized`), names every row whose timezone was assumed rather than read (a
  naive `due` has none to recover, so reading it as local is a guess and an unattributable guess is
  worse than a loud one), names every row in a format it does not recognize without claiming to know
  whether that spelling carried a zone, and reports the surviving offset-suffixed
  count — shouting `MIGRATION INCOMPLETE` if it is nonzero. Per-row lines are capped at 20 so a
  large legacy database cannot flood stderr; the counts themselves are never truncated. A healthy
  database still prints nothing and takes no write lock.

### Changed
- A `due` with no offset (`2026-04-01T09:00:00`) is documented as, and read as, **local** time.
- A bare date (`2026-04-01`) is now read as **local** midnight rather than UTC midnight. ECMA-262
  parses date-only forms as UTC, which contradicted the rule above and, west of Greenwich, fired
  the reminder the previous evening.
- The legacy JSON import no longer renames the source file to `.migrated` when any row was skipped,
  so the only copy of unimported data is preserved for manual recovery.

## [0.2.0] - 2026-03-30

### Changed
- **Breaking**: Migrated storage from JSON + file lock to SQLite + WAL mode — resolves lock contention with 8+ concurrent agent processes
- DB location: `~/obsidian/data/ticklers.db` (override with `TICKLER_DB_PATH` env var)
- Version reset to `0.2.0` to reflect pre-v1 quality (breaking storage change)
- `store.ts` public API changed: `readStore/writeStore/withLock` removed, replaced with `createTickler/listTicklers/checkTicklers/completeTickler/deleteTickler/snoozeTickler/getTickler`

### Added
- Auto-migration: existing `~/.tickler/ticklers.json` is imported into SQLite on first startup and renamed to `.migrated`
- `test/store.test.ts` — CRUD, migration, and concurrency tests
- `test/mcp.test.ts` — MCP handler logic tests
- `test/cli.test.ts` — CLI smoke tests
- `better-sqlite3` dependency

### Removed
- File lock mechanism (`acquireLock`, `releaseLock`, `withLock`, `clearStaleLock`)

## [1.0.1] - 2026-03-26

### Added
- Plugin packaging: `.claude-plugin/marketplace.json` for per-repo direct install
- `src/version.ts` as single source of truth for runtime version
- `skills/tickler/SKILL.md` with YAML frontmatter and `allowed-tools` list
- `scripts/release.sh` for automated release workflow
- `CHANGELOG.md` (this file)

### Changed
- `prepublishOnly` script renamed to `prepack` (runs on both `npm pack` and `npm publish`)
- Added `test` and `release` scripts to `package.json`
- `files` array updated to `dist/`, `.claude-plugin/`, `skills/` (trailing slashes, correct skill dir)
- `engines.node` bumped to `>=20.0.0` (commander@14 requires Node 20)
- README restructured: plugin install (two-step) first, then manual install

## [1.0.0] - 2026-03-24

### Added
- Initial open-source release
- 6 MCP tools: `tickler_create`, `tickler_check`, `tickler_list`, `tickler_complete`, `tickler_delete`, `tickler_snooze`
- CLI with matching commands
- Local JSON store at `~/.tickler/ticklers.json`
- File locking to prevent concurrent write corruption
- Duration parsing: "1d", "3h", "1w", "30m"
- Claude Code plugin packaging (`.claude-plugin/plugin.json`)
- `CLAUDE.md` dev guide

[Unreleased]: https://github.com/daveremy/tickler-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/daveremy/tickler-mcp/compare/v1.0.1...v0.2.0
[1.0.1]: https://github.com/daveremy/tickler-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/daveremy/tickler-mcp/releases/tag/v1.0.0
