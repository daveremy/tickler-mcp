# tickler-mcp — Dev Guide

## What It Is
An MCP server + CLI for persistent ticklers/reminders. JSON storage on disk — ticklers survive agent session restarts.

## Structure

```
src/
  types.ts    — Tickler and TicklerStore interfaces
  store.ts    — Read/write/lock logic, STORAGE_PATH resolution
  mcp.ts      — MCP server (stdio transport)
  cli.ts      — CLI entry point (commander.js)
```

## Build

```bash
npm install
npm run build
```

Outputs to `dist/`. Both `dist/cli.js` and `dist/mcp.js` get `chmod +x`.

## Test Locally

```bash
# CLI
node dist/cli.js create "Test reminder" --due "2026-04-01T09:00:00Z" --body "Test"
node dist/cli.js list
node dist/cli.js check

# MCP (stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp.js
```

## Storage

Default: `~/.tickler/ticklers.json`
Override: `TICKLER_STORAGE_PATH=/tmp/test.json node dist/mcp.js`

## Publish

```bash
npm publish --access public
```

Requires npm login as daveremy.

## Design Decisions

- **No database** — JSON file is fine for a personal reminder system. Hundreds of ticklers at most.
- **File lock** — spin lock via exclusive file open. Handles concurrent MCP + CLI access safely.
- **Atomic writes** — write to .tmp then rename, so a crash mid-write doesn't corrupt the store.
- **No external deps beyond SDK and commander** — keeps install fast and npx startup snappy.
