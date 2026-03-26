#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as crypto from "crypto";
import type { Tickler } from "./types.js";
import { readStore, writeStore, withLock, formatTickler } from "./store.js";
import { parseDuration } from "./duration.js";

const VERSION = "1.0.0";

const server = new McpServer({ name: "tickler-mcp", version: VERSION });

server.tool(
  "tickler_create",
  "Create a new tickler/reminder that persists across agent session restarts",
  {
    title: z.string().describe("Short title for the reminder"),
    body: z.string().describe("Details or notes for the reminder"),
    due: z.string().describe("ISO 8601 due date/time (e.g. 2026-04-01T09:00:00-07:00)"),
    tags: z.array(z.string()).optional().describe("Optional tags for filtering (e.g. [\"eng\", \"clubexpress\"])"),
    creator: z.string().optional().describe("Agent or user creating this tickler (e.g. karpathy, marcus)"),
  },
  async ({ title, body, due, tags = [], creator = "unknown" }) => {
    const dueDate = new Date(due);
    if (isNaN(dueDate.getTime())) {
      return { content: [{ type: "text" as const, text: `Error: Invalid due date "${due}". Use ISO 8601 format.` }], isError: true };
    }

    const tickler: Tickler = {
      id: crypto.randomUUID(),
      title,
      body,
      due,
      tags,
      creator,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    withLock(() => {
      const store = readStore();
      store.ticklers.push(tickler);
      writeStore(store);
    });

    return {
      content: [{
        type: "text" as const,
        text: `Created tickler: ${tickler.id}\nTitle: ${tickler.title}\nDue: ${tickler.due}\nTags: ${tickler.tags.join(", ") || "none"}`,
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
    const store = readStore();
    let results = store.ticklers;

    if (status) results = results.filter((t) => t.status === status);
    if (tag) results = results.filter((t) => t.tags.includes(tag));
    results = results.sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No ticklers found." }] };
    }

    const formatted = results.map((t) => formatTickler(t)).join("\n\n");
    return { content: [{ type: "text" as const, text: `${results.length} tickler(s):\n\n${formatted}` }] };
  },
);

server.tool(
  "tickler_check",
  "Return only past-due pending ticklers (due <= now). Designed for cron polling — call this at the start of each review session.",
  {},
  async () => {
    const now = new Date();
    const store = readStore();
    const overdue = store.ticklers
      .filter((t) => t.status === "pending" && new Date(t.due) <= now)
      .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());

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
    let found = false;
    let ticklerTitle = "";

    withLock(() => {
      const store = readStore();
      const tickler = store.ticklers.find((t) => t.id === id);
      if (!tickler) return;
      found = true;
      ticklerTitle = tickler.title;
      tickler.status = "done";
      tickler.completedAt = new Date().toISOString();
      writeStore(store);
    });

    if (!found) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Marked complete: "${ticklerTitle}" (${id})` }] };
  },
);

server.tool(
  "tickler_delete",
  "Permanently delete a tickler. Use tickler_complete to keep history instead.",
  {
    id: z.string().describe("ID of the tickler to delete"),
  },
  async ({ id }) => {
    let found = false;
    let ticklerTitle = "";

    withLock(() => {
      const store = readStore();
      const idx = store.ticklers.findIndex((t) => t.id === id);
      if (idx === -1) return;
      found = true;
      ticklerTitle = store.ticklers[idx].title;
      store.ticklers.splice(idx, 1);
      writeStore(store);
    });

    if (!found) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Deleted: "${ticklerTitle}" (${id})` }] };
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

    let found = false;
    let newDue = "";
    let ticklerTitle = "";

    withLock(() => {
      const store = readStore();
      const tickler = store.ticklers.find((t) => t.id === id);
      if (!tickler) return;
      found = true;
      ticklerTitle = tickler.title;
      const due = new Date(tickler.due);
      due.setTime(due.getTime() + ms);
      newDue = due.toISOString();
      tickler.due = newDue;
      // Re-open a completed tickler if it's being snoozed
      if (tickler.status === "done") {
        tickler.status = "pending";
        tickler.completedAt = null;
      }
      writeStore(store);
    });

    if (!found) {
      return { content: [{ type: "text" as const, text: `Error: No tickler found with ID "${id}"` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Snoozed "${ticklerTitle}" by ${duration} — new due: ${newDue}` }] };
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
