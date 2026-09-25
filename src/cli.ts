#!/usr/bin/env node
import { Command } from "commander";
import * as crypto from "crypto";
import type { Tickler, Nag, NotifyChannel } from "./types.js";
import {
  createTickler,
  listTicklers,
  checkTicklers,
  checkNotifyDue,
  claimNotifyFire,
  completeTickler,
  deleteTickler,
  snoozeTickler,
  getTickler,
  formatTickler,
  getDbPath,
  normalizeDue,
} from "./store.js";
import { parseDuration } from "./duration.js";
import { VERSION } from "./version.js";
import { resolveRecurForCreate, type Recur, type Weekday } from "./recur.js";

const WEEKDAY_CODES: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * Parse `--recur` CLI syntax: `daily`, `weekly:SU` (or `weekly:SU,TU`), `monthly:15`.
 * An optional `:N` interval suffix on the freq itself is not supported from the CLI (use the
 * MCP tool's `interval` field for that) — this mirrors the MCP schema's `Recur` shape, just
 * flattened into one string plus the required `--tz` flag.
 */
function parseRecurSpec(spec: string, tz: string): Recur {
  // Exactly one colon at most (freq, or freq:rest) — an extra colon (e.g. "weekly:SU:extra")
  // must be rejected, not silently truncated by destructuring split(":") (codex round-4 code
  // review, issue #9).
  const parts = spec.split(":");
  if (parts.length > 2) {
    throw new RangeError(`Invalid --recur "${spec}" — expected "freq" or "freq:rest", found an extra ":".`);
  }
  const [freqRaw, restRaw] = parts;
  const freq = freqRaw as Recur["freq"];
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") {
    throw new RangeError(`Invalid --recur freq "${freqRaw}" — expected daily, weekly, or monthly.`);
  }
  const recur: Recur = { freq, tz };
  if (freq === "weekly") {
    if (!restRaw) throw new RangeError('--recur weekly needs a weekday, e.g. "weekly:SU"');
    const days = restRaw.split(",").map((d) => d.trim().toUpperCase());
    for (const d of days) {
      if (!WEEKDAY_CODES.includes(d as Weekday)) {
        throw new RangeError(`Invalid weekday "${d}" in --recur — expected one of ${WEEKDAY_CODES.join(",")}.`);
      }
    }
    recur.byWeekday = days as Weekday[];
  } else if (freq === "monthly") {
    if (!restRaw) throw new RangeError('--recur monthly needs a day, e.g. "monthly:15"');
    // `parseInt` alone accepts "1.5" (truncates to 1) and "15junk" (stops at the first
    // non-digit) without error, silently building a different schedule than the caller typed
    // (codex round-4 code review, issue #9) — require the ENTIRE token to be plain digits
    // before converting.
    if (!/^\d+$/.test(restRaw)) {
      throw new RangeError(`Invalid day "${restRaw}" in --recur — expected an integer 1-31.`);
    }
    const day = parseInt(restRaw, 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new RangeError(`Invalid day "${restRaw}" in --recur — expected an integer 1-31.`);
    }
    recur.byMonthDay = day;
  } else if (restRaw !== undefined) {
    // "daily" takes no ":" suffix — an interval belongs in the MCP tool's `interval` field,
    // per this function's own doc comment. Before this fix "daily:2" silently succeeded and
    // dropped the "2", building an interval:1 (every day) schedule instead of the interval:2
    // the caller typed (codex round-5 code review, issue #9).
    throw new RangeError(
      `--recur "daily" does not take a ":" suffix — interval isn't supported from the CLI (use the MCP tool's interval field). Got "${spec}".`
    );
  }
  return recur;
}

const program = new Command();

program
  .name("tickler")
  .description("CLI for tickler-mcp — persistent reminders that survive session restarts")
  .version(VERSION);

program
  .command("check")
  .description("Show past-due pending ticklers (exit 1 if any are due, 0 if none). A due nag tickler is shown again once its interval elapses, until completed or exhausted.")
  .option("--no-mark-fired", "dry read — don't advance nag state (lastFiredAt/fire count)")
  .option("--notify-due", "Return due telegram:dave ticklers as JSON (read-only) instead of the normal agent check")
  .action((opts: { markFired: boolean; notifyDue?: boolean }) => {
    // Full alternative branch, checked first: the Telegram poller's read must never touch
    // the agent path's mark-fired logic (or anything else in this action).
    if (opts.notifyDue) {
      // Wrapped so a DB/open error exits 2, distinct from exit 1's "items are due" — a
      // poller reading only the exit code must be able to tell "crashed" from "nothing
      // urgent" (round-1 code review finding: both shared exit 1 before this fix).
      try {
        const due = checkNotifyDue();
        // Read-only on purpose — the poller sends first, then claims via notify-mark-fired,
        // so a failed send leaves the tickler due rather than losing it.
        console.log(JSON.stringify(due.map(t => ({ id: t.id, title: t.title, body: t.body, due: t.due, lastFiredAt: t.lastFiredAt })), null, 2));
        process.exit(due.length > 0 ? 1 : 0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }
    }

    const overdue = checkTicklers(opts.markFired);

    if (overdue.length === 0) {
      console.log("No past-due ticklers.");
      process.exit(0);
    }
    console.log(`${overdue.length} past-due tickler(s):\n`);
    overdue.forEach((t) => console.log(formatTickler(t) + "\n"));
    process.exit(1);
  });

program
  .command("notify-mark-fired <id>")
  .description("Claim a notify-due fire for <id> after a confirmed send (tickler-mcp#11). Exit 0 = claimed, 1 = lost race/no longer eligible, 2 = usage/DB error.")
  .requiredOption("--prev-fired-at <value>", 'The lastFiredAt token from `check --notify-due` JSON output — pass "none" (or "null", or an empty string) if it was null')
  .action((id: string, opts: { prevFiredAt: string }) => {
    // Accept "none", "null" and "" as the null token, not just the literal "none" the
    // description asks for — `jq -r '.[].lastFiredAt'` on a JSON `null` prints the text
    // "null", not "none", so the obvious shell pipeline a caller reaches for would
    // otherwise silently pass a wrong token through as a literal string compare that
    // matches no row (round-1 code review finding, BLOCKING: this previously caused an
    // eligible tickler to read exit 1 "lost race", the same code path as a real lost
    // race, and never get marked fired — a false-pass that resent the tickler forever).
    const NULL_TOKENS = new Set(["none", "null", ""]);
    const prev = NULL_TOKENS.has(opts.prevFiredAt) ? null : opts.prevFiredAt;
    try {
      const claimed = claimNotifyFire(id, prev, new Date().toISOString());
      if (claimed) {
        console.log(`Claimed: ${id}`);
        process.exit(0);
      } else {
        console.error(`Not claimed (lost race or no longer eligible): ${id}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(2);
    }
  });

program
  .command("list")
  .description("List ticklers")
  .option("--status <status>", "Filter: pending or done")
  .option("--tag <tag>", "Filter by tag")
  .action((opts: { status?: string; tag?: string }) => {
    if (opts.status && opts.status !== "pending" && opts.status !== "done") {
      console.error('Error: --status must be "pending" or "done"');
      process.exit(1);
    }

    const status = opts.status as "pending" | "done" | undefined;
    const results = listTicklers({ status, tag: opts.tag });

    if (results.length === 0) {
      console.log("No ticklers found.");
      return;
    }
    console.log(`${results.length} tickler(s):\n`);
    results.forEach((t) => console.log(formatTickler(t) + "\n"));
  });

program
  .command("create <title>")
  .description('Create a tickler: tickler create "Review PR" --due "2026-04-01T09:00:00-07:00" --tags eng,review')
  .requiredOption(
    "--due <date>",
    "Due date (ISO 8601 or YYYY-MM-DD). Stored as UTC; a value with no offset is read as local time"
  )
  .option("--body <body>", "Details or notes", "")
  .option("--tags <tags>", "Comma-separated tags (e.g. eng,clubexpress)")
  .option("--creator <creator>", "Who is creating this", "cli")
  .option("--recur <spec>", 'Recurrence: "daily", "weekly:SU" (comma for multiple), or "monthly:15". Requires --tz.')
  .option("--tz <zone>", "IANA timezone for --recur, e.g. America/Phoenix")
  .option("--nag <duration>", 'Re-fire every duration once due, e.g. "1d", "4h", until completed. Cadences under 1d only fire once/day until tickler-mcp#11 lands.')
  .option("--nag-max <n>", "Total nag fires before exhaustion (requires --nag)")
  .option("--notify <channel>", 'Notification channel: "agent" (default) or "telegram:dave"', "agent")
  .action((title: string, opts: { due: string; body: string; tags?: string; creator: string; recur?: string; tz?: string; nag?: string; nagMax?: string; notify: string }) => {
    if (opts.notify !== "agent" && opts.notify !== "telegram:dave") {
      console.error('Error: --notify must be "agent" or "telegram:dave"');
      process.exit(1);
    }
    const notify: NotifyChannel = opts.notify;

    // Normalize up front so the value printed back is the value stored.
    let due: string;
    try {
      due = normalizeDue(opts.due);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : [];

    let recur: Recur | null = null;
    let snappedNote = "";
    if (opts.recur) {
      if (!opts.tz) {
        console.error("Error: --recur requires --tz.");
        process.exit(1);
      }
      try {
        const parsedRecur = parseRecurSpec(opts.recur, opts.tz);
        const result = resolveRecurForCreate(parsedRecur, due);
        if (result.snapped) snappedNote = " (snapped forward to match the recur rule)";
        due = result.due;
        recur = result.recur;
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    if (opts.nagMax !== undefined && !opts.nag) {
      console.error("Error: --nag-max requires --nag.");
      process.exit(1);
    }

    let nag: Nag | null = null;
    if (opts.nag) {
      const everyMs = parseDuration(opts.nag);
      if (everyMs === null || everyMs <= 0) {
        console.error(`Error: Invalid --nag "${opts.nag}". Use formats like "1d", "3h", "1w", "30m".`);
        process.exit(1);
      }
      let max: number | undefined;
      if (opts.nagMax !== undefined) {
        // Require the ENTIRE token to be plain digits before converting — same guard as
        // --recur monthly's day parsing (parseInt alone silently truncates "5junk"/"5.5").
        if (!/^\d+$/.test(opts.nagMax) || parseInt(opts.nagMax, 10) < 1) {
          console.error(`Error: Invalid --nag-max "${opts.nagMax}" — expected a positive integer.`);
          process.exit(1);
        }
        max = parseInt(opts.nagMax, 10);
      }
      nag = { every: opts.nag, max };
    }

    const tickler: Tickler = {
      id: crypto.randomUUID(),
      title,
      body: opts.body,
      due,
      tags,
      creator: opts.creator,
      notify,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
      recur,
      nag,
      lastFiredAt: null,
      nagFireCount: 0,
    };

    createTickler(tickler);

    console.log(`Created: ${tickler.id}`);
    console.log(`Title:   ${tickler.title}`);
    console.log(`Due:     ${tickler.due}${snappedNote}`);
    if (tags.length > 0) console.log(`Tags:    ${tags.join(", ")}`);
    if (recur) console.log(`Recur:   ${opts.recur} ${opts.tz}`);
    if (nag) console.log(`Nag:     every ${nag.every}${nag.max !== undefined ? ` (max ${nag.max})` : ""}`);
    if (notify !== "agent") console.log(`Notify:  ${notify}`);
    console.log(`Store:   ${getDbPath()}`);
  });

program
  .command("complete <id>")
  .description("Mark a tickler as done (keeps history)")
  .action((id: string) => {
    const tickler = getTickler(id);
    if (!tickler) {
      console.error(`Error: No tickler found with ID "${id}"`);
      process.exit(1);
    }
    const result = completeTickler(id);
    console.log(`Marked complete: "${tickler.title}" (${id})`);
    if (result.nextId) {
      console.log(`Next occurrence: ${result.nextId}, due ${result.nextDue}`);
    }
  });

program
  .command("delete <id>")
  .description("Permanently delete a tickler (use complete to keep history)")
  .action((id: string) => {
    const tickler = getTickler(id);
    if (!tickler) {
      console.error(`Error: No tickler found with ID "${id}"`);
      process.exit(1);
    }
    deleteTickler(id);
    console.log(`Deleted: "${tickler.title}" (${id})`);
  });

program
  .command("snooze <id> <duration>")
  .description('Push due date forward. Duration examples: "1d" (1 day), "3h" (3 hours), "1w" (1 week), "30m" (30 min)')
  .action((id: string, duration: string) => {
    const ms = parseDuration(duration);
    if (ms === null) {
      console.error(`Error: Invalid duration "${duration}". Use formats like "1d", "3h", "1w", "30m".`);
      process.exit(1);
    }

    const tickler = getTickler(id);
    if (!tickler) {
      console.error(`Error: No tickler found with ID "${id}"`);
      process.exit(1);
    }

    const due = new Date(tickler.due);
    due.setTime(due.getTime() + ms);
    const newDue = due.toISOString();
    snoozeTickler(id, newDue);

    console.log(`Snoozed "${tickler.title}" by ${duration} — new due: ${newDue}`);
  });

program.parse();
