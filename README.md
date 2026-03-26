# tickler-mcp

Persistent ticklers/reminders for Claude Code agents and any MCP client. Ticklers are stored in a local JSON file — they survive session restarts, reconnects, and machine reboots.

**The core problem it solves:** Claude agents run in sessions. When a session ends, in-memory state is gone. If an agent wants to follow up on something in 3 days, it has no place to put that intention. tickler-mcp is that place.

## Install

### As an MCP server (recommended)

```bash
# npx — no install required
npx -y @daveremy/tickler-mcp

# or install globally
npm install -g @daveremy/tickler-mcp
```

### Claude Code plugin

```bash
claude plugin add @daveremy/tickler-mcp
```

Or add manually to `.mcp.json`:

```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "npx",
      "args": ["-y", "@daveremy/tickler-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "npx",
      "args": ["-y", "@daveremy/tickler-mcp"]
    }
  }
}
```

### Cursor

Add to your MCP config under `mcpServers` — same format as Claude Desktop above.

## Storage

Default: `~/.tickler/ticklers.json`

Override with an environment variable:

```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "npx",
      "args": ["-y", "@daveremy/tickler-mcp"],
      "env": {
        "TICKLER_STORAGE_PATH": "/path/to/your/ticklers.json"
      }
    }
  }
}
```

## MCP Tools

| Tool | Description |
|---|---|
| `tickler_create` | Create a new tickler |
| `tickler_check` | Return past-due pending ticklers (use in cron/morning review) |
| `tickler_list` | List all ticklers, optionally filtered by status or tag |
| `tickler_complete` | Mark a tickler done |
| `tickler_delete` | Permanently remove a tickler |
| `tickler_snooze` | Push due date forward by a duration: "1d", "3h", "1w", "30m" |

## CLI

After installing globally or via npx:

```bash
# Check what's due
tickler check

# List all
tickler list
tickler list --status pending
tickler list --tag projects

# Create
tickler create "Follow up on invoice" --due "2026-04-01T09:00:00-07:00" --body "Invoice #1042 sent March 26"
tickler create "Weekly review" --due "2026-03-30T08:00:00-07:00" --tags "recurring,review"

# Complete
tickler complete <id>

# Delete
tickler delete <id>

# Snooze (duration string: 30m, 3h, 1d, 1w)
tickler snooze <id> 3d
tickler snooze <id> 4h
```

## Integration Patterns

### Morning review polling

In your daily review routine, call `tickler_check` first. If anything is returned, surface it to the user before proceeding with the rest of the review.

### Agent cron jobs

Agents running on a schedule (via `CronCreate`) can call `tickler_check` at startup. This is the primary use case — an agent sets a tickler, the session ends, and a future session picks it up automatically.

Example prompt:
```
At the start of each session, call tickler_check. If any past-due ticklers are found,
surface them to the user and ask what to do.
```

### Creating follow-ups from within a session

```
User: "Remind me to follow up on this in a week"
Agent: [calls tickler_create with due = now + 7 days]
```

### Snoozing instead of completing

If the user isn't ready to act on a tickler but doesn't want it cluttering the list:

```
Agent: [calls tickler_snooze with id: "...", duration: "3d"]
```

## Future: Push Notifications via MCP Sampling

The MCP specification includes a Sampling capability that would allow servers to proactively notify clients — essentially push notifications from the MCP server to the agent. When client support for Sampling matures, tickler-mcp can be extended to push overdue reminders without requiring a polling step.

For now, polling via `tickler_check` in cron jobs and morning reviews is the reliable pattern.

## Development

```bash
git clone https://github.com/daveremy/tickler-mcp.git
cd tickler-mcp
npm install
npm run build

# Test CLI
node dist/cli.js create "Test" --due "2026-04-01T00:00:00Z" --body "testing"
node dist/cli.js list

# Test MCP (stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/mcp.js
```

See `CLAUDE.md` for full dev guide.

## License

MIT
