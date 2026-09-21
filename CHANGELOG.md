# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-15

### Added
- **Nag ticklers** ([#10](https://github.com/daveremy/tickler-mcp/issues/10)). `tickler_create` /
  `tickler create --nag <duration> [--nag-max <n>]` accept an optional `nag` rule
  (`{every: string, max?: number}`). Once due, `tickler_check` keeps returning the tickler every
  `every` — not just once — until `tickler_complete` or `max` fires are used; the fire that
  reaches `max` is flagged `nag-exhausted` in its display and stops being returned, while the
  tickler stays `pending` (still visible via `tickler_list`) until completed or deleted. New
  `tickler_check` param / CLI flag `mark_fired` / `--no-mark-fired` (default `true`) opts into a
  dry read that leaves nag state untouched — `tickler_list` is always a dry read. Snoozing a nag
  tickler pauses its cadence and resumes it at the new due (treated as a fresh first fire) without
  resetting the `max` exhaustion budget. A recurring-and-nagging series' successor inherits the
  `nag` rule but starts its own fresh fire history. Sub-1-day `every` values only re-fire as often
  as the caller actually polls `tickler_check` until a due-time poller
  ([#11](https://github.com/daveremy/tickler-mcp/issues/11)) exists — documented in the tool
  description and README rather than solved here.
  - Stored as flat `nag_every`/`nag_max`/`last_fired_at`/`nag_fire_count` columns (not a JSON
    blob, unlike `recur`) so `checkTicklers` can exclude already-exhausted rows directly in SQL.
    Added via the same idempotent `ensureColumn` migration guard `recur` uses.
  - A nag fire is claimed with a compare-and-swap `UPDATE` (`claimNagFire`, exported for direct
    testing) guarded on `status`, `due`, `nag_max`, and the candidate's own previously-read
    `last_fired_at` — closing a race where concurrent MCP processes could otherwise double-count
    a fire past `max`, or fire a tickler a concurrent snooze had just pushed into the future.
- **Recurring ticklers** ([#9](https://github.com/daveremy/tickler-mcp/issues/9)). `tickler_create`
  and `tickler create --recur` accept an optional typed `recur` rule
  (`{freq: "daily"|"weekly"|"monthly", interval?, byWeekday?, byMonthDay?, tz}`) instead of an
  RRULE string — nothing here needs the RFC 5545 surface, and a typed shape is what an MCP client
  can validate. `due` is still the first occurrence, snapped forward to the next matching date if
  it doesn't already match the rule. Completing a recurring occurrence (`tickler_complete` /
  `tickler complete`) atomically marks it done and creates exactly one next pending occurrence, in
  `recur.tz`, skipping past any missed slots so the new due is never in the past. Deleting the
  pending occurrence ends the series (no separate `stop_series` flag — one pending row per series
  by construction). `tickler_list` / `formatTickler` / the CLI show the rule inline, e.g.
  `↻ weekly SU 07:00 America/Phoenix`. New `recur TEXT` column, nullable, added via an idempotent
  migration guard (`pragma table_info` + `ALTER TABLE ... ADD COLUMN`) — existing rows read back
  with `recur: null`, byte-for-byte unchanged behavior when `recur` is omitted.
  - Timezone-aware occurrence math (`src/recur.ts`) uses only `Intl.DateTimeFormat` — no new
    runtime dependency. Each recurring series carries a fixed `recur.anchor` (its own first
    occurrence, set once and never modified afterward), which every frequency's calendar
    schedule and canonical time-of-day are always measured against — so a biweekly weekly rule
    stays biweekly regardless of which week the series started in or how many weekdays it
    names, and snoozing one occurrence (to a different date, a different time, or both) can
    never shift the date, time, or displayed rule of the occurrences that follow it. A monthly
    rule's day-of-month is persisted explicitly at
    creation (from the first occurrence when the caller omits `byMonthDay`), so it can never
    drift after a clamped short month (e.g. day-31 surviving a February landing at day 28). A
    genuinely nonexistent (spring-forward gap) or ambiguous (fall-back overlap) wall time has no
    designed resolution policy; this was reviewed and accepted at the plan stage (out of scope:
    no acceptance criterion tests it). Most US/EU zones transition in the small hours, but a few
    (America/Santiago, America/Havana, Asia/Beirut) transition at or near midnight, so an
    ordinary-looking due time can still land in the gap/overlap window there.
  - A design review (round 4) also found the anchor-based math didn't yet fully achieve
    "schedule depends on `due` only as a `>` filter": `nextOccurrence`/`formatRecur` now throw
    if `recur.anchor` is missing rather than silently falling back to the (possibly snoozed)
    current occurrence's own wall time — the fallback had been the actual root cause of three
    rounds of anchor-alignment bugs. The weekly branch now tests the candidate occurrence's
    instant (not just its calendar day) against the search floor, so it can return a
    same-day-but-later occurrence. `--recur` on the CLI now rejects a non-integer or trailing-
    junk day, an extra `:`-separated segment, and an unsupported interval suffix on `daily`,
    instead of silently building a different schedule than typed.

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

[Unreleased]: https://github.com/daveremy/tickler-mcp/compare/v1.2.0...HEAD
[0.2.0]: https://github.com/daveremy/tickler-mcp/compare/v1.0.1...v0.2.0
[1.0.1]: https://github.com/daveremy/tickler-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/daveremy/tickler-mcp/releases/tag/v1.0.0
[1.2.0]: https://github.com/daveremy/tickler-mcp/releases/tag/v1.2.0
