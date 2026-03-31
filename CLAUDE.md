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
- **Tags as JSON text** — `string[]` stored as `JSON.stringify([...])` in a TEXT column. Simple, portable, preserves order.
- **`getTickler()` before mutating** — `complete`, `delete`, and `snooze` call `getTickler()` first to return the title in the success message, consistent with the original behavior.
