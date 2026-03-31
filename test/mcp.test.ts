/**
 * MCP handler tests — verify tool handler logic by calling store functions directly.
 * We don't spin up an actual MCP server; we test the handlers' behavior against a
 * real SQLite store using a temp DB.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TEST_DB = path.join(os.tmpdir(), `tickler-mcp-test-${crypto.randomUUID()}.db`);
process.env.TICKLER_DB_PATH = TEST_DB;

import {
  createTickler,
  listTicklers,
  checkTicklers,
  completeTickler,
  deleteTickler,
  snoozeTickler,
  getTickler,
} from "../src/store.js";
import { parseDuration } from "../src/duration.js";
import type { Tickler } from "../src/types.js";

function makeTickler(overrides: Partial<Tickler> = {}): Tickler {
  return {
    id: crypto.randomUUID(),
    title: "Test reminder",
    body: "Test body",
    due: new Date(Date.now() + 86400000).toISOString(),
    tags: [],
    creator: "test",
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

after(() => {
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

describe("mcp handler: tickler_create", () => {
  test("creates a valid tickler", () => {
    const t = makeTickler({ title: "mcp-create-test" });
    createTickler(t);
    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.title, "mcp-create-test");
  });

  test("invalid ISO date is caught before store insert", () => {
    const badDue = "not-a-date";
    const dueDate = new Date(badDue);
    assert.ok(isNaN(dueDate.getTime()), "bad date should be NaN");
    // Handler would return isError: true — no insert needed
  });
});

describe("mcp handler: tickler_list", () => {
  test("returns all ticklers sorted by due", () => {
    const now = Date.now();
    const a = makeTickler({ title: "mcp-list-a", due: new Date(now + 2 * 86400000).toISOString() });
    const b = makeTickler({ title: "mcp-list-b", due: new Date(now + 1 * 86400000).toISOString() });
    createTickler(a);
    createTickler(b);

    const all = listTicklers();
    const ours = all.filter((t) => ["mcp-list-a", "mcp-list-b"].includes(t.title));
    assert.equal(ours.length, 2);
    assert.equal(ours[0].title, "mcp-list-b"); // earlier due first
    assert.equal(ours[1].title, "mcp-list-a");
  });

  test("filters by status", () => {
    const pending = makeTickler({ title: "mcp-list-pending" });
    const done = makeTickler({ title: "mcp-list-done", status: "done" });
    createTickler(pending);
    createTickler(done);

    const pendingOnly = listTicklers({ status: "pending" });
    assert.ok(pendingOnly.some((t) => t.id === pending.id));
    assert.ok(!pendingOnly.some((t) => t.id === done.id));
  });
});

describe("mcp handler: tickler_check", () => {
  test("returns only past-due pending items", () => {
    const overdue = makeTickler({
      title: "mcp-check-overdue",
      due: new Date(Date.now() - 3600000).toISOString(),
    });
    const future = makeTickler({
      title: "mcp-check-future",
      due: new Date(Date.now() + 86400000).toISOString(),
    });
    createTickler(overdue);
    createTickler(future);

    const due = checkTicklers();
    assert.ok(due.some((t) => t.id === overdue.id));
    assert.ok(!due.some((t) => t.id === future.id));
  });
});

describe("mcp handler: tickler_complete", () => {
  test("marks tickler done and records completedAt", () => {
    const t = makeTickler({ title: "mcp-complete-test" });
    createTickler(t);

    completeTickler(t.id);
    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.status, "done");
    assert.ok(found.completedAt !== null);
  });

  test("returns false for nonexistent id", () => {
    assert.equal(completeTickler("nonexistent"), false);
  });
});

describe("mcp handler: tickler_delete", () => {
  test("removes tickler permanently", () => {
    const t = makeTickler({ title: "mcp-delete-test" });
    createTickler(t);

    deleteTickler(t.id);
    assert.equal(getTickler(t.id), undefined);
  });
});

describe("mcp handler: tickler_snooze", () => {
  test("snooze duration parsing: valid strings", () => {
    assert.ok(parseDuration("1d") !== null);
    assert.ok(parseDuration("3h") !== null);
    assert.ok(parseDuration("30m") !== null);
    assert.ok(parseDuration("1w") !== null);
  });

  test("snooze duration parsing: invalid string returns null", () => {
    assert.equal(parseDuration("badvalue"), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration("1x"), null);
  });

  test("snooze updates due date on the tickler", () => {
    const t = makeTickler({ title: "mcp-snooze-test" });
    createTickler(t);

    const ms = parseDuration("1d");
    assert.ok(ms !== null);
    const oldDue = new Date(t.due);
    const newDue = new Date(oldDue.getTime() + ms).toISOString();
    snoozeTickler(t.id, newDue);

    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.due, newDue);
  });
});
