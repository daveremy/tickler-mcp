#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as crypto from "crypto";
import type { Tickler, Nag } from "./types.js";
import {
  createTickler,
  listTicklers,
  checkTicklers,
  completeTickler,
  deleteTickler,
  snoozeTickler,
  getTickler,
  formatTickler,
  normalizeDue,
} from "./store.js";
import { parseDuration } from "./duration.js";
import { VERSION } from "./version.js";
import { resolveRecurForCreate, type Recur } from "./recur.js";

const WEEKDAY_ENUM = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const recurSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly"]).describe("Recurrence frequency"),
    interval: z.number().int().min(1).optional().describe("Repeat every N periods (default 1)"),
    byWeekday: z
      .array(z.enum(WEEKDAY_ENUM))
      .optional()
      .describe("Weekly only: which weekdays (e.g. [\"SU\"])"),
    byMonthDay: z.number().int().min(1).max(31).optional().describe("Monthly only: day of month (clamped in short months)"),
    tz: z.string().describe("IANA timezone the rule's time-of-day is anchored to, e.g. America/Phoenix"),
  })
  .optional()
  .describe(
    "Optional recurrence rule. When present, `due` is the first occurrence (snapped forward " +
      "to the next matching date if it doesn't already match the rule). Completing an " +
      "occurrence creates the next one automatically."
  );

const nagSchema = z
  .object({
    every: z.string().describe("Re-fire interval, a duration string e.g. \"1d\", \"4h\""),
    max: z.number().int().min(1).optional().describe("Total fires before exhaustion (omit for unlimited)"),
  })
  .optional()
  .describe(
    "Optional nag rule. Once due, `tickler_check` keeps returning this tickler every `every` " +
      "until `tickler_complete` or `max` fires are reached (flagged nag-exhausted on the final " +
      "fire, still pending). Nag cadences shorter than 1 day only fire once per the daily " +
      "morning tickler_check route until a due-time poller (tickler-mcp#11) lands."
  );

const server = new McpServer({ name: "tickler-mcp", version: VERSION });

server.tool(
  "tickler_create",
  "Create a new tickler/reminder that persists across agent session restarts",
  {
    title: z.string().describe("Short title for the reminder"),
    body: z.string().describe("Details or notes for the reminder"),
    due: z.string().describe(
      "ISO 8601 due date/time (e.g. 2026-04-01T09:00:00-07:00). Stored as UTC. " +
        "A timestamp with no offset (2026-04-01T09:00:00) and a bare date (2026-04-01) " +
        "are both read as the server's LOCAL time — pass an explicit offset to be unambiguous."
    ),
    tags: z.array(z.string()).optional().describe("Optional tags for filtering (e.g. [\"eng\", \"clubexpress\"])"),
    creator: z.string().optional().describe("Agent or user creating this tickler (e.g. karpathy, marcus)"),
    notify: z.enum(["agent", "telegram:dave"]).optional().describe(
      "Notification channel: \"agent\" (default) — today's behavior, agent session polls tickler_check. " +
        "\"telegram:dave\" — delivered via a Telegram poller job instead (tickler-mcp#11); not surfaced by tickler_check."
    ),
    recur: recurSchema,
    nag: nagSchema,
  },
  async ({ title, body, due: dueInput, tags = [], creator = "unknown", notify, recur, nag }) => {
    // Normalize up front so the value echoed back is the value stored.
    let due: string;
    try {
      due = normalizeDue(dueInput);
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }

    let snappedNote = "";
    let resolvedRecur: Recur | null = null;
    if (recur) {
      try {
        const result = resolveRecurForCreate(recur as Recur, due);
        if (result.snapped) {
          snappedNote = `\nNote: due did not match the recur rule — snapped forward to the first matching occurrence.`;
        }
        due = result.due;
        resolvedRecur = result.recur;
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }

    let resolvedNag: Nag | null = null;
    if (nag) {
      const everyMs = parseDuration(nag.every);
      if (everyMs === null || everyMs <= 0) {
        return {
          content: [{ type: "text" as const, text: `Error: Invalid nag.every "${nag.every}". Use formats like "1d", "3h", "1w", "30m".` }],
          isError: true,
        };
      }
      resolvedNag = { every: nag.every, max: nag.max };
    }

    const tickler: Tickler = {
      id: crypto.randomUUID(),
      title,
      body,
      due,
      tags,
      creator,
      notify: notify ?? "agent",
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
      recur: resolvedRecur,
      nag: resolvedNag,
      lastFiredAt: null,
      nagFireCount: 0,
    };

    createTickler(tickler);

    return {
      content: [{
        type: "text" as const,
        text: `Created tickler: ${tickler.id}\nTitle: ${tickler.title}\nDue: ${tickler.due}\nTags: ${tickler.tags.join(", ") || "none"}${snappedNote}`,
      }],
    };
  },
);

server.tool(
  "tickler_list",
  "List ticklers, optionally filtered by status or tag. Returns all by default.",
  {
    status: z.enum(["pending", "done"]).optional().describe("Filter by status (omit for all)"),
    tag: z.string().optional().describe("Filter by tag (exact match)"),
  },
  async ({ status, tag }) => {
    const results = listTicklers({ status, tag });

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No ticklers found." }] };
    }

    const formatted = results.map((t) => formatTickler(t)).join("\n\n");
    return { content: [{ type: "text" as const, text: `${results.length} tickler(s):\n\n${formatted}` }] };
  },
);

server.tool(
  "tickler_check",
  "Return only past-due pending ticklers (due <= now). Designed for cron polling — call this at the start of each review session. " +
    "A due nag tickler is returned again on later calls once its `every` interval elapses, until completed or exhausted. " +
    "Nag cadences shorter than 1 day only fire once per the daily morning route until a due-time poller (tickler-mcp#11) lands.",
  {
    mark_fired: z.boolean().optional().describe(
      "Default true. Set false for a dry read that does not advance nag state (lastFiredAt/fire count) — use tickler_list for that instead when possible."
    ),
  },
  async ({ mark_fired }) => {
    const overdue = checkTicklers(mark_fired ?? true);

    if (overdue.length === 0) {
      return { content: [{ type: "text" as const, text: "No past-due ticklers." }] };
    }

    const formatted = overdue.map((t) => formatTickler(t)).join("\n\n");
    return { content: [{ type: "text" as const, text: `${overdue.length} past-due tickler(s):\n\n${formatted}` }] };
  },
);

server.tool(
  "tickler_complete",
  "Mark a tickler as done. Keeps history — does not delete the record.",
  {
    id: z.string().describe("ID of the tickler to mark complete"),
  },
  async ({ id }) => {
    const tickler = getTickler(id);
    if (!tickler) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }
    const result = completeTickler(id);
    const nextNote = result.nextId ? `\nNext occurrence created: ${result.nextId}, due ${result.nextDue}` : "";
    return { content: [{ type: "text" as const, text: `Marked complete: "${tickler.title}" (${id})${nextNote}` }] };
  },
);

server.tool(
  "tickler_delete",
  "Permanently delete a tickler. Use tickler_complete to keep history instead.",
  {
    id: z.string().describe("ID of the tickler to delete"),
  },
  async ({ id }) => {
    const tickler = getTickler(id);
    if (!tickler) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }
    deleteTickler(id);
    return { content: [{ type: "text" as const, text: `Deleted: "${tickler.title}" (${id})` }] };
  },
);

server.tool(
  "tickler_snooze",
  "Push a tickler's due date forward by a duration. Examples: \"1d\" (1 day), \"3h\" (3 hours), \"1w\" (1 week).",
  {
    id: z.string().describe("ID of the tickler to snooze"),
    duration: z.string().describe("Duration string: e.g. \"1d\", \"3h\", \"1w\", \"30m\""),
  },
  async ({ id, duration }) => {
    const ms = parseDuration(duration);
    if (ms === null) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid duration "${duration}". Use formats like "1d", "3h", "1w", "30m".` }],
        isError: true,
      };
    }

    const tickler = getTickler(id);
    if (!tickler) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }

    const due = new Date(tickler.due);
    due.setTime(due.getTime() + ms);
    const newDue = due.toISOString();
    snoozeTickler(id, newDue);

    return { content: [{ type: "text" as const, text: `Snoozed "${tickler.title}" by ${duration} — new due: ${newDue}` }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`tickler-mcp v${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("tickler-mcp fatal error:", err);
  process.exit(1);
});
