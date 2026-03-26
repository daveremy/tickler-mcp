# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/daveremy/tickler-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/daveremy/tickler-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/daveremy/tickler-mcp/releases/tag/v1.0.0
