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
} from "./store.js";
import { parseDuration } from "./duration.js";
import { VERSION } from "./version.js";

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
  .requiredOption("--due <date>", "Due date (ISO 8601 or YYYY-MM-DD)")
  .option("--body <body>", "Details or notes", "")
  .option("--tags <tags>", "Comma-separated tags (e.g. eng,clubexpress)")
  .option("--creator <creator>", "Who is creating this", "cli")
  .action((title: string, opts: { due: string; body: string; tags?: string; creator: string }) => {
    const dueDate = new Date(opts.due);
    if (isNaN(dueDate.getTime())) {
      console.error(`Error: Invalid due date "${opts.due}". Use ISO 8601 format.`);
      process.exit(1);
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : [];

    const tickler: Tickler = {
      id: crypto.randomUUID(),
      title,
      body: opts.body,
      due: opts.due,
      tags,
      creator: opts.creator,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    createTickler(tickler);

    console.log(`Created: ${tickler.id}`);
    console.log(`Title:   ${tickler.title}`);
    console.log(`Due:     ${tickler.due}`);
    if (tags.length > 0) console.log(`Tags:    ${tags.join(", ")}`);
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
    completeTickler(id);
    console.log(`Marked complete: "${tickler.title}" (${id})`);
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
