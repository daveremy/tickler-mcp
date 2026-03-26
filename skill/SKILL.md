# Tickler — Persistent Reminders

Use this skill to create, check, and manage ticklers: reminders that persist across agent session restarts via a local JSON store.

## When to Use

- Agent wants to follow up on something in N days
- User asks to be reminded about something later
- Checking if any pending reminders are due during a morning review or cron job

## Tools

- `tickler_create` — Create a new reminder
- `tickler_check` — Return past-due pending ticklers (use in cron/morning review)
- `tickler_list` — List all ticklers, optionally filtered by status or tag
- `tickler_complete` — Mark a tickler done
- `tickler_delete` — Permanently remove a tickler
- `tickler_snooze` — Push due date forward by a duration string: "1d", "3h", "1w", "30m"

## Usage Patterns

### Morning review cron
Call `tickler_check` at the start of each daily review. If any ticklers are returned, surface them to the user before proceeding.

### Creating a follow-up
```
tickler_create:
  title: "Follow up on trailer sale listing"
  body: "Check if listing is getting views. Re-list on Facebook if needed."
  due: "2026-04-07T09:00:00-07:00"
  tags: ["trailer", "projects"]
  creator: "marcus"
```

### Snoozing
If the user isn't ready to act: `tickler_snooze` with `id` and `duration: "3d"`.

### Completing
Once actioned: `tickler_complete` with the tickler ID.

## Storage

Default: `~/.tickler/ticklers.json`
Override: set `TICKLER_PATH` env var before starting the MCP server.

## Notes

- IDs are UUIDs — always use the full ID for complete/delete/snooze
- `tickler_check` only returns past-due items. Use `tickler_list` to see all.
- Ticklers survive session restarts — they persist on disk, not in memory
