import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// Each test suite gets its own DB file via env var
const TEST_DB = path.join(os.tmpdir(), `tickler-test-${crypto.randomUUID()}.db`);
process.env.TICKLER_DB_PATH = TEST_DB;

// Import store AFTER setting env var (lazy DB init)
import {
  createTickler,
  listTicklers,
  checkTicklers,
  completeTickler,
  deleteTickler,
  snoozeTickler,
  getTickler,
  runMigration,
} from "../src/store.js";
import type { Tickler } from "../src/types.js";

function makeTickler(overrides: Partial<Tickler> = {}): Tickler {
  return {
    id: crypto.randomUUID(),
    title: "Test reminder",
    body: "Test body",
    due: new Date(Date.now() + 86400000).toISOString(), // 1 day from now
    tags: [],
    creator: "test",
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

after(() => {
  // Clean up test DB
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

describe("store: CRUD", () => {
  test("create and retrieve a tickler", () => {
    const t = makeTickler({ title: "crud-create" });
    createTickler(t);
    const found = getTickler(t.id);
    assert.ok(found, "getTickler should return the created tickler");
    assert.equal(found.title, "crud-create");
    assert.equal(found.status, "pending");
    assert.deepEqual(found.tags, []);
  });

  test("create with tags round-trips correctly", () => {
    const t = makeTickler({ title: "tagged", tags: ["eng", "review"] });
    createTickler(t);
    const found = getTickler(t.id);
    assert.ok(found);
    assert.deepEqual(found.tags, ["eng", "review"]);
  });

  test("list returns all ticklers sorted by due date", () => {
    // Create 3 with different due dates
    const ids = ["list-a", "list-b", "list-c"];
    const now = Date.now();
    const ticklers = [
      makeTickler({ id: ids[0], title: "list-a", due: new Date(now + 3 * 86400000).toISOString() }),
      makeTickler({ id: ids[1], title: "list-b", due: new Date(now + 1 * 86400000).toISOString() }),
      makeTickler({ id: ids[2], title: "list-c", due: new Date(now + 2 * 86400000).toISOString() }),
    ];
    ticklers.forEach(createTickler);

    const all = listTicklers();
    // Verify our 3 are present and sorted
    const ourTicklers = all.filter((t) => ids.includes(t.id));
    assert.equal(ourTicklers.length, 3);
    // Should be sorted: list-b, list-c, list-a
    assert.equal(ourTicklers[0].title, "list-b");
    assert.equal(ourTicklers[1].title, "list-c");
    assert.equal(ourTicklers[2].title, "list-a");
  });

  test("list filtered by status", () => {
    const pending = makeTickler({ title: "filter-pending" });
    const done = makeTickler({ title: "filter-done", status: "done" });
    createTickler(pending);
    createTickler(done);

    const pendingList = listTicklers({ status: "pending" });
    const doneList = listTicklers({ status: "done" });

    assert.ok(pendingList.some((t) => t.id === pending.id));
    assert.ok(!pendingList.some((t) => t.id === done.id));
    assert.ok(doneList.some((t) => t.id === done.id));
    assert.ok(!doneList.some((t) => t.id === pending.id));
  });

  test("list filtered by tag", () => {
    const tagged = makeTickler({ title: "filter-tagged", tags: ["eng", "feature"] });
    const notTagged = makeTickler({ title: "filter-untagged", tags: ["docs"] });
    createTickler(tagged);
    createTickler(notTagged);

    const results = listTicklers({ tag: "eng" });
    assert.ok(results.some((t) => t.id === tagged.id));
    assert.ok(!results.some((t) => t.id === notTagged.id));
  });
});

describe("store: check (overdue)", () => {
  test("checkTicklers returns past-due pending items", () => {
    const overdue = makeTickler({
      title: "overdue-item",
      due: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    });
    const future = makeTickler({
      title: "future-item",
      due: new Date(Date.now() + 86400000).toISOString(),
    });
    createTickler(overdue);
    createTickler(future);

    const due = checkTicklers();
    assert.ok(due.some((t) => t.id === overdue.id), "overdue item should appear");
    assert.ok(!due.some((t) => t.id === future.id), "future item should not appear");
  });

  test("checkTicklers excludes done ticklers even if past due", () => {
    const donePastDue = makeTickler({
      title: "done-past-due",
      due: new Date(Date.now() - 3600000).toISOString(),
      status: "done",
    });
    createTickler(donePastDue);

    const due = checkTicklers();
    assert.ok(!due.some((t) => t.id === donePastDue.id));
  });
});

describe("store: complete", () => {
  test("completeTickler marks as done and returns true", () => {
    const t = makeTickler({ title: "complete-me" });
    createTickler(t);

    const result = completeTickler(t.id);
    assert.equal(result, true);

    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.status, "done");
    assert.ok(found.completedAt !== null, "completedAt should be set");
  });

  test("completeTickler returns false for unknown id", () => {
    const result = completeTickler("nonexistent-id");
    assert.equal(result, false);
  });
});

describe("store: delete", () => {
  test("deleteTickler removes the record and returns true", () => {
    const t = makeTickler({ title: "delete-me" });
    createTickler(t);

    const result = deleteTickler(t.id);
    assert.equal(result, true);

    const found = getTickler(t.id);
    assert.equal(found, undefined);
  });

  test("deleteTickler returns false for unknown id", () => {
    const result = deleteTickler("nonexistent-id");
    assert.equal(result, false);
  });
});

describe("store: snooze", () => {
  test("snoozeTickler updates due date and returns true", () => {
    const t = makeTickler({ title: "snooze-me" });
    createTickler(t);

    const newDue = new Date(Date.now() + 7 * 86400000).toISOString();
    const result = snoozeTickler(t.id, newDue);
    assert.equal(result, true);

    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.due, newDue);
    assert.equal(found.status, "pending");
  });

  test("snoozeTickler re-opens a done tickler", () => {
    const t = makeTickler({ title: "snooze-done", status: "done" });
    createTickler(t);

    const newDue = new Date(Date.now() + 86400000).toISOString();
    snoozeTickler(t.id, newDue);

    const found = getTickler(t.id);
    assert.ok(found);
    assert.equal(found.status, "pending");
    assert.equal(found.completedAt, null);
  });

  test("snoozeTickler returns false for unknown id", () => {
    const result = snoozeTickler("nonexistent-id", new Date().toISOString());
    assert.equal(result, false);
  });
});

describe("store: JSON migration", () => {
  test("imports records from JSON into a fresh SQLite DB", () => {
    const migrationDb = path.join(os.tmpdir(), `tickler-migration-${crypto.randomUUID()}.db`);
    const legacyJson = path.join(os.tmpdir(), `ticklers-legacy-${crypto.randomUUID()}.json`);

    const legacyTicklers: Tickler[] = [
      makeTickler({ title: "legacy-1", tags: ["a", "b"] }),
      makeTickler({ title: "legacy-2" }),
    ];

    fs.writeFileSync(legacyJson, JSON.stringify({ ticklers: legacyTicklers }));

    // runMigration accepts a string path and opens its own DB
    runMigration(migrationDb, legacyJson);

    // Verify JSON was renamed
    assert.ok(fs.existsSync(legacyJson + ".migrated"), "JSON should be renamed to .migrated");
    assert.ok(!fs.existsSync(legacyJson), "original JSON should no longer exist");

    // Clean up
    try { fs.unlinkSync(migrationDb); } catch { /* ignore */ }
    try { fs.unlinkSync(migrationDb + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(migrationDb + "-shm"); } catch { /* ignore */ }
    try { fs.unlinkSync(legacyJson + ".migrated"); } catch { /* ignore */ }
  });

  test("is a no-op when JSON file does not exist", () => {
    const migrationDb = path.join(os.tmpdir(), `tickler-noop-${crypto.randomUUID()}.db`);
    const nonExistent = path.join(os.tmpdir(), `nonexistent-${crypto.randomUUID()}.json`);
    // Should not throw
    runMigration(migrationDb, nonExistent);
    // DB may or may not be created — just verify no crash
    try { fs.unlinkSync(migrationDb); } catch { /* ignore */ }
  });

  test("skips corrupted JSON and leaves file intact", () => {
    const migrationDb = path.join(os.tmpdir(), `tickler-corrupt-${crypto.randomUUID()}.db`);
    const corruptedJson = path.join(os.tmpdir(), `ticklers-corrupted-${crypto.randomUUID()}.json`);
    fs.writeFileSync(corruptedJson, "{ not valid json");

    // Should not throw — logs warning and returns
    runMigration(migrationDb, corruptedJson);

    // File should still exist (was not renamed or deleted)
    assert.ok(fs.existsSync(corruptedJson), "corrupted file should be left intact");
    assert.ok(!fs.existsSync(corruptedJson + ".migrated"), "should NOT be renamed");

    // Clean up
    fs.unlinkSync(corruptedJson);
    try { fs.unlinkSync(migrationDb); } catch { /* ignore */ }
  });
});

describe("store: concurrent operations", () => {
  test("20 concurrent creates do not crash or lose data", async () => {
    const prefix = `concurrent-${crypto.randomUUID().slice(0, 8)}`;
    const count = 20;

    // WAL mode allows 1 writer + concurrent readers; better-sqlite3 is synchronous
    // so "concurrent" here means rapid sequential calls from Promise.all
    const ops = Array.from({ length: count }, (_, i) =>
      Promise.resolve().then(() => {
        const t = makeTickler({ title: `${prefix}-${i}` });
        createTickler(t);
        return t.id;
      })
    );

    const ids = await Promise.all(ops);
    assert.equal(ids.length, count);

    const all = listTicklers();
    const ours = all.filter((t) => t.title.startsWith(prefix));
    assert.equal(ours.length, count, `Expected ${count} ticklers, got ${ours.length}`);
  });
});
