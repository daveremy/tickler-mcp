# tickler-mcp — Dev Guide

## What It Is
An MCP server + CLI for persistent ticklers/reminders. SQLite storage on disk (WAL mode) — ticklers survive agent session restarts. Handles concurrent access from 8+ LifeOS agents (16 MCP processes) without lock contention.

## Structure

```
src/
  types.ts      — Tickler interface
  store.ts      — SQLite store (better-sqlite3, WAL mode), JSON migration, CRUD exports
  mcp.ts        — MCP server (stdio transport, 6 tools)
  cli.ts        — CLI entry point (commander.js)
  duration.ts   — Duration string parser ("1d", "3h", "1w", "30m")
  version.ts    — Version constant (single source of truth)
test/
  store.test.ts — Store unit tests (CRUD, migration, concurrent ops)
  mcp.test.ts   — MCP handler logic tests
  cli.test.ts   — CLI smoke tests
```

## Build

```bash
npm install
npm run build
```

Outputs to `dist/`. Both `dist/cli.js` and `dist/mcp.js` get `chmod +x`.

## Test

```bash
npm test
```

Uses `node --import tsx --test test/*.test.ts`. Tests use `TICKLER_DB_PATH` env var to point at temp files — isolated from production data.

## Dev (local MCP)

```bash
npm run dev   # tsx src/mcp.ts — stdio transport
```

Or with the local `.mcp.json`:
```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "node",
      "args": ["dist/mcp.js"]
    }
  }
}
```

## Test Locally

```bash
# Build first
npm run build

# CLI
node dist/cli.js create "Test reminder" --due "2026-04-01T09:00:00Z" --body "Test"
node dist/cli.js list
node dist/cli.js check

# MCP (stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp.js
```

## Storage

Default: `~/obsidian/data/ticklers.db` (SQLite, WAL mode)
Override: `TICKLER_DB_PATH=/tmp/test.db node dist/mcp.js`

Legacy JSON (`~/.tickler/ticklers.json`) is auto-migrated to SQLite on first startup and renamed to `ticklers.json.migrated`.

## Publish

```bash
npm run release patch   # bump patch, build, publish to npm, push to GitHub
```

Or manually:
```bash
npm publish --access public
```

Requires npm login as daveremy.

## Design Decisions

- **SQLite + WAL mode** — Handles 16+ concurrent MCP processes without lock contention. Concurrent reads are non-blocking; writes serialize automatically.
- **better-sqlite3** — Synchronous SQLite API; avoids async complexity. Works correctly in both MCP (async tool handlers) and CLI (sync code).
- **Auto-migration** — On first startup, if `~/.tickler/ticklers.json` exists, all records are imported into SQLite in a single transaction and the JSON file is renamed to `.migrated`. No data loss.
- **`due` is normalized to UTC-Z on write, never parsed on read** — `checkTicklers` compares `due` against `new Date().toISOString()` using SQLite's lexicographic `<=`. That is a valid instant comparison only if every stored value is in the same frame, so `normalizeDue()` canonicalizes at every write path (create, snooze, JSON import). Storing input verbatim made offset and naive timestamps fire up to a full UTC offset early (issue #3). Normalizing on write keeps `due` usable as a sort/range key; parsing on read would fix `checkTicklers` but not `listTicklers`'s `ORDER BY due ASC`. **A timestamp with no offset — including a bare `YYYY-MM-DD` — is read as LOCAL time**, which is the right reading of author intent and is decided at the write boundary where that intent still exists. `normalizeStoredDueDates()` backfills legacy rows on every DB open rather than behind a `user_version` gate, because with 16 concurrent MCP processes an older binary can write a legacy row after a one-time migration has already run.
- **The backfill reports itself, and reports its post-condition (issue #6)** — a repair prints counts by stored shape before and after, names every row whose timezone it had to assume, and states the surviving offset-suffixed count, shouting `MIGRATION INCOMPLETE` if it is nonzero. "No errors" is not evidence a migration worked. Three rules hold the output honest: it is emitted **after** the transaction commits (a rollback must never leave a log claiming rows were rewritten); a pass that finds **no candidates prints nothing** (16 processes racing one upgrade would otherwise print 15 empty backfills for one real migration); and where the code cannot tell whether a non-ISO spelling carried a timezone, it **says so** instead of guessing — `Date.parse` reads the zone in `Sun, 01 Mar 2026 09:00:00 GMT` and assumes local for `March 1, 2026 09:00`, and distinguishing them means reimplementing an implementation-defined grammar. Per-row lines cap at `MAX_LOGGED_ROWS`; counts never truncate. All output is stderr — stdout carries JSON-RPC.
- **Tags as JSON text** — `string[]` stored as `JSON.stringify([...])` in a TEXT column. Simple, portable, preserves order.
- **`getTickler()` before mutating** — `complete`, `delete`, and `snooze` call `getTickler()` first to return the title in the success message, consistent with the original behavior.
