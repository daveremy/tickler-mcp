# tickler-mcp

Persistent ticklers/reminders for Claude Code agents and any MCP client. Ticklers are stored in a local JSON file — they survive session restarts, reconnects, and machine reboots.

**The core problem it solves:** Claude agents run in sessions. When a session ends, in-memory state is gone. If an agent wants to follow up on something in 3 days, it has no place to put that intention. tickler-mcp is that place.

## Plugin Install (Claude Code)

Two steps — add the marketplace, then install the plugin:

```bash
claude plugin marketplace add daveremy/tickler-mcp
claude plugin install tickler-mcp@tickler-mcp-plugins --scope user
```

Start a new Claude Code session after installing. The 6 tickler MCP tools will be available, and the bundled `/tickler` skill will work automatically.

## Manual Install

Add to your `.mcp.json` (or `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "tickler-mcp", "tickler-mcp"]
    }
  }
}
```

Or install globally:

```bash
npm install -g tickler-mcp
```

## Tools Reference

| Tool | Description |
|---|---|
| `tickler_create` | Create a new tickler. Accepts optional `recur` and `nag` rules — see below |
| `tickler_check` | Return past-due pending ticklers (use in cron/morning review). Accepts an optional `mark_fired` flag — see Nag ticklers below |
| `tickler_list` | List all ticklers, optionally filtered by status or tag |
| `tickler_complete` | Mark a tickler done. If it was recurring, also creates the next occurrence |
| `tickler_delete` | Permanently remove a tickler |
| `tickler_snooze` | Push due date forward by a duration: "1d", "3h", "1w", "30m" |

### Recurring ticklers

`tickler_create` takes an optional `recur` object instead of a plain `due`-only tickler:

```json
{
  "freq": "weekly",
  "byWeekday": ["SU"],
  "tz": "America/Phoenix"
}
```

- `freq`: `"daily" | "weekly" | "monthly"`.
- `interval` (optional, default 1): repeat every N periods, anchored to the series' own fixed
  first occurrence (not a fixed calendar epoch, and not whichever occurrence you're completing
  right now) — a weekly `interval: 2` rule always lands two weeks after wherever the series
  actually started, whichever week that was, even with multiple `byWeekday` entries. Snoozing
  one occurrence to a different date or time never shifts the schedule of the occurrences that
  follow it.
- `byWeekday` (weekly only): which weekdays, e.g. `["SU"]` or `["MO","WE","FR"]`.
- `byMonthDay` (monthly only): day of month, 1-31. Clamped in short months (`31` on a 30-day month
  lands on the 30th) without losing the nominal day — the *next* month's occurrence still targets
  the original day.
- `tz` (required): IANA timezone the rule's time-of-day is anchored to. "07:00 every Sunday" stays
  07:00 in `tz` across any DST transitions in that zone.

`due` on create is the first occurrence. If it doesn't already match the rule, it's snapped
forward to the next date that does, and the response says so.

Completing a recurring occurrence (`tickler_complete`) marks it done and atomically creates the
next pending occurrence — in `tz`, and never in the past (if several were missed, it skips
straight to the next future slot). Only one pending occurrence exists per series at a time;
deleting it ends the series (there's no separate "stop recurring" flag). `tickler_list` and the
CLI show the rule inline: `↻ weekly SU 07:00 America/Phoenix`.

### Nag ticklers

`tickler_create` also takes an optional `nag` object — a re-fire rule for a tickler you want
`tickler_check` to keep surfacing, not just fire once:

```json
{
  "every": "1d",
  "max": 5
}
```

- `every` (required): a duration string — `"30m"`, `"4h"`, `"1d"`, `"1w"`.
- `max` (optional): total fires before exhaustion. Omitted means unlimited.

Once a nag tickler is due, `tickler_check` returns it, then keeps returning it again every
`every` on later calls — until `tickler_complete` is called, or `max` fires have been used. On
the fire that reaches `max`, the tickler is flagged `nag-exhausted` in its display and
`tickler_check` stops returning it, but it stays `pending` (visible in `tickler_list`) until
completed or deleted.

`tickler_check` takes an optional `mark_fired` parameter (default `true`). Pass `mark_fired:
false` for a dry read that returns due ticklers without advancing any nag's fire count or
`lastFiredAt` — useful for a preview that shouldn't consume a nag cycle. `tickler_list` is
always a dry read; it never advances nag state.

Snoozing a nag tickler pauses its cadence — `due` moves to the future exactly as for any
tickler — and resumes it at the new `due`, treating that as a fresh first fire rather than
waiting out the original interval from before the snooze. The exhaustion budget (`nagFireCount`
vs `max`) is not reset by a snooze.

Completing a recurring **and** nagging tickler's occurrence carries the `nag` rule to the
successor, but the successor starts its own fresh nag cycle (`lastFiredAt: null`, fire count
reset to 0) — it does not inherit the completed occurrence's fire history.

⚠️ **Sub-1-day cadences are capped by your polling frequency.** `every` shorter than a day (e.g.
`"4h"`) only actually re-fires as often as whatever calls `tickler_check` — typically once per
day via a morning review route. The `agent` channel still works this way. A `telegram:dave`
tickler is delivered by a due-time poller instead — see below — so its cadence is bounded by
that poller's own interval, not by an agent session.

### Telegram delivery (`notify: "telegram:dave"`)

`tickler_create` / `tickler create` take an optional `notify` channel — `"agent"` (default,
today's behavior: surfaced via `tickler_check` in an agent session) or `"telegram:dave"`
([tickler-mcp#11](https://github.com/daveremy/tickler-mcp/issues/11)). A `telegram:dave`
tickler is never returned by the agent-facing `tickler_check` / `tickler check` — it is
delivered by a separate due-time poller instead (in this repo's case, a lifeos job that polls
every ~15 min; see that repo's `scripts/jobs/tickler-telegram-notify.sh`).

The poller uses a two-phase read/claim, both exposed on the CLI:

1. `tickler check --notify-due` — a **read-only** JSON dump of due `telegram:dave` ticklers
   (`id`, `title`, `body`, `due`, `lastFiredAt`). Exit 1 if any are due, 0 if none, 2 on error.
   It never marks anything fired.
2. After a **confirmed** send, the poller calls `tickler notify-mark-fired <id>
   --prev-fired-at <token>`, where `<token>` is that tickler's `lastFiredAt` from step 1 (pass
   `"none"`, `"null"`, or an empty string if it was `null`). This is a compare-and-swap claim:
   exit 0 = claimed, 1 = lost race / no longer eligible (already fired by a concurrent run, no
   longer due, etc. — safe to skip), 2 = usage/DB error.

A failed send therefore never marks the tickler fired — it stays due and is retried on the
poller's next pass, rather than being lost. A non-nag `telegram:dave` tickler fires exactly
once, ever, since nothing re-polls it into anyone's attention the way an agent session's
`tickler_check` does; a nagging `telegram:dave` tickler re-fires per its own `nag.every`/`max`,
same rule as the `agent` channel.

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

# Create, recurring: weekly on Sunday, monthly on the 15th, or daily.
# --recur takes "daily", "weekly:SU" (comma-separate for multiple days), or "monthly:15" — --tz is required.
tickler create "Pickleball registration" --due "2026-09-20T07:00:00" --recur "weekly:SU" --tz "America/Phoenix" --tags pickleball

# Create, nagging: re-fire every 1d until completed or 5 fires are used
tickler create "Renew passport" --due "2026-10-01T09:00:00-07:00" --nag "1d" --nag-max 5

# Check without advancing nag state (dry read)
tickler check --no-mark-fired

# Complete — if the tickler is recurring, this also creates the next occurrence
tickler complete <id>

# Delete
tickler delete <id>

# Snooze (duration string: 30m, 3h, 1d, 1w)
tickler snooze <id> 3d
tickler snooze <id> 4h
```

## Skills

The plugin bundles a `/tickler` skill. After installing the plugin, use it directly:

```
/tickler check
/tickler create "Follow up on invoice in 3 days"
```

The skill orchestrates tool calls and presents results conversationally.

## Storage

Default: `~/.tickler/ticklers.json`

Override with an environment variable:

```json
{
  "mcpServers": {
    "tickler-mcp": {
      "command": "npx",
      "args": ["-y", "-p", "tickler-mcp", "tickler-mcp"],
      "env": {
        "TICKLER_PATH": "/path/to/your/ticklers.json"
      }
    }
  }
}
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

### Release

```bash
npm run release patch   # 0.1.0 -> 0.1.1
npm run release minor   # 0.1.1 -> 0.2.0
npm run release major   # 0.2.0 -> 1.0.0
```

See `CLAUDE.md` for full dev guide.

## License

MIT
