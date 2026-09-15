#!/usr/bin/env node
import { Command } from "commander";
import * as crypto from "crypto";
import type { Tickler } from "./types.js";
import {
  createTickler,
  listTicklers,
  checkTicklers,
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
  .description("Show past-due pending ticklers (exit 1 if any are due, 0 if none)")
  .action(() => {
    const overdue = checkTicklers();

    if (overdue.length === 0) {
      console.log("No past-due ticklers.");
      process.exit(0);
    }
    console.log(`${overdue.length} past-due tickler(s):\n`);
    overdue.forEach((t) => console.log(formatTickler(t) + "\n"));
    process.exit(1);
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
  .action((title: string, opts: { due: string; body: string; tags?: string; creator: string; recur?: string; tz?: string }) => {
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

    const tickler: Tickler = {
      id: crypto.randomUUID(),
      title,
      body: opts.body,
      due,
      tags,
      creator: opts.creator,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
      recur,
    };

    createTickler(tickler);

    console.log(`Created: ${tickler.id}`);
    console.log(`Title:   ${tickler.title}`);
    console.log(`Due:     ${tickler.due}${snappedNote}`);
    if (tags.length > 0) console.log(`Tags:    ${tags.join(", ")}`);
    if (recur) console.log(`Recur:   ${opts.recur} ${opts.tz}`);
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
