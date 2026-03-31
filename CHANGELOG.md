# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
