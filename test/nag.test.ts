/**
 * Nag ticklers (issue #10) — re-fire rule tests.
 *
 * Mirrors store.test.ts's conventions: a dedicated temp DB set via TICKLER_DB_PATH before
 * store.ts is imported, and CLI validation tests spawn the built dist/cli.js the same way
 * test/cli.test.ts does (the CLI's own process boundary is the only place --nag/--nag-max
 * validation is observable end to end).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import Database from "better-sqlite3";

function tmpDbPath(label: string): string {
  return path.join(os.tmpdir(), `tickler-nag-${label}-${crypto.randomUUID()}.db`);
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

const TEST_DB = tmpDbPath("main");
process.env.TICKLER_DB_PATH = TEST_DB;

import {
  createTickler,
  listTicklers,
  checkTicklers,
  completeTickler,
  deleteTickler,
  snoozeTickler,
  getTickler,
  claimNagFire,
  ensureNagColumns,
  formatTickler,
  TICKLERS_SCHEMA_SQL,
} from "../src/store.js";
import { resolveRecurForCreate } from "../src/recur.js";
import type { Tickler } from "../src/types.js";

function makeTickler(overrides: Partial<Tickler> = {}): Tickler {
  return {
    id: crypto.randomUUID(),
    title: "Nag test reminder",
    body: "Test body",
    due: new Date(Date.now() - 3600000).toISOString(), // 1h in the past — already due
    tags: [],
    creator: "test",
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    recur: null,
    nag: null,
    lastFiredAt: null,
    nagFireCount: 0,
    ...overrides,
  };
}

after(() => rmDb(TEST_DB));

describe("nag: non-nag ticklers are unaffected (regression guard)", () => {
  test("checkTicklers still returns a plain due tickler, unchanged, every call", () => {
    const t = makeTickler({ title: "nag-regression-plain" });
    createTickler(t);

    const first = checkTicklers();
    assert.ok(first.some((r) => r.id === t.id));

    const second = checkTicklers();
    assert.ok(second.some((r) => r.id === t.id), "a plain tickler must keep being returned every call");
  });
});

describe("nag: basic fire cadence", () => {
  test("first checkTicklers call after due fires it and sets lastFiredAt/nagFireCount:1", () => {
    const t = makeTickler({ title: "nag-first-fire", nag: { every: "1h" } });
    createTickler(t);

    const due = checkTicklers();
    const found = due.find((r) => r.id === t.id);
    assert.ok(found, "a newly-due nag tickler must fire on the first check");
    assert.ok(found!.lastFiredAt !== null);
    assert.equal(found!.nagFireCount, 1);
  });

  test("a second call before `every` elapses does not return it again", () => {
    const t = makeTickler({ title: "nag-not-yet-again", nag: { every: "1h" } });
    createTickler(t);

    checkTicklers(); // first fire
    const second = checkTicklers();
    assert.ok(!second.some((r) => r.id === t.id), "must not re-fire before the interval elapses");
  });

  test("a third call after `every` elapses fires again with count:2", () => {
    const t = makeTickler({ title: "nag-refire-elapsed", nag: { every: "1h" } });
    createTickler(t);

    checkTicklers(); // first fire, count:1
    // Fast-forward by backdating lastFiredAt directly (same pattern as recur tests using a
    // past anchor) — simulate more than 1h having elapsed since the first fire.
    const db = new Database(TEST_DB);
    db.prepare("UPDATE ticklers SET last_fired_at = @t WHERE id = @id").run({
      id: t.id,
      t: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    db.close();

    const third = checkTicklers();
    const found = third.find((r) => r.id === t.id);
    assert.ok(found, "must re-fire once `every` has elapsed since the last fire");
    assert.equal(found!.nagFireCount, 2);
  });
});

describe("nag: exhaustion (max)", () => {
  test("the final allowed fire is returned; the call after that is not (loop ends), but tickler_list still shows it pending", () => {
    const t = makeTickler({ title: "nag-exhaustion", nag: { every: "1h", max: 2 } });
    createTickler(t);

    checkTicklers(); // fire 1/2
    const db = new Database(TEST_DB);
    db.prepare("UPDATE ticklers SET last_fired_at = @t WHERE id = @id").run({
      id: t.id,
      t: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    db.close();

    const secondFire = checkTicklers(); // fire 2/2 — the final allowed one
    const found = secondFire.find((r) => r.id === t.id);
    assert.ok(found, "the final allowed fire must still be returned");
    assert.equal(found!.nagFireCount, 2);

    // Push lastFiredAt back again — even so, exhaustion must exclude it now.
    const db2 = new Database(TEST_DB);
    db2.prepare("UPDATE ticklers SET last_fired_at = @t WHERE id = @id").run({
      id: t.id,
      t: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    db2.close();

    const afterExhaustion = checkTicklers();
    assert.ok(!afterExhaustion.some((r) => r.id === t.id), "an exhausted nag tickler must not be returned by checkTicklers again");

    const stillListed = listTicklers({ status: "pending" });
    assert.ok(stillListed.some((r) => r.id === t.id), "tickler_list must still show the exhausted tickler while it stays pending");
  });

  test("max:1 exhausts immediately on the very first fire", () => {
    const t = makeTickler({ title: "nag-exhaustion-max-one", nag: { every: "1h", max: 1 } });
    createTickler(t);

    const firstFire = checkTicklers();
    const found = firstFire.find((r) => r.id === t.id);
    assert.ok(found, "the single allowed fire must still be returned");
    assert.equal(found!.nagFireCount, 1);

    const db = new Database(TEST_DB);
    db.prepare("UPDATE ticklers SET last_fired_at = @t WHERE id = @id").run({
      id: t.id,
      t: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    db.close();

    const afterExhaustion = checkTicklers();
    assert.ok(!afterExhaustion.some((r) => r.id === t.id), "max:1 must exhaust immediately after its one fire");

    const exhausted = getTickler(t.id)!;
    assert.match(
      formatTickler(exhausted),
      /nag-exhausted/,
      "exhaustion must be visible in the formatted display, not just in the returned data"
    );
  });
});

describe("nag: delete mid-cadence", () => {
  test("deleting a nag tickler mid-cadence removes it cleanly with no error or orphaned state", () => {
    const t = makeTickler({ title: "nag-delete-mid-cadence", nag: { every: "1h", max: 3 } });
    createTickler(t);

    checkTicklers(); // fire 1/3
    assert.ok(getTickler(t.id));

    const db = new Database(TEST_DB);
    const before = db.prepare("SELECT COUNT(*) as cnt FROM ticklers WHERE id = @id").get({ id: t.id }) as { cnt: number };
    assert.equal(before.cnt, 1);
    db.close();

    assert.doesNotThrow(() => deleteTickler(t.id));
    assert.equal(getTickler(t.id), undefined, "the row must be gone");

    const afterCheck = checkTicklers();
    assert.ok(!afterCheck.some((r) => r.id === t.id), "a deleted nag tickler must never resurface via checkTicklers");
  });
});

describe("nag: mark_fired:false is a dry read", () => {
  test("checkTicklers(false) never advances lastFiredAt/nagFireCount across repeated calls", () => {
    const t = makeTickler({ title: "nag-dry-read", nag: { every: "1h" } });
    createTickler(t);

    const first = checkTicklers(false);
    const found1 = first.find((r) => r.id === t.id);
    assert.ok(found1);
    assert.equal(found1!.lastFiredAt, null);
    assert.equal(found1!.nagFireCount, 0);

    const second = checkTicklers(false);
    const found2 = second.find((r) => r.id === t.id);
    assert.ok(found2, "a dry read must keep returning the same still-eligible tickler");
    assert.equal(found2!.lastFiredAt, null);
    assert.equal(found2!.nagFireCount, 0);

    const persisted = getTickler(t.id);
    assert.equal(persisted!.lastFiredAt, null, "no DB write must occur on a dry read");
    assert.equal(persisted!.nagFireCount, 0);
  });
});

describe("nag: tickler_complete ends the loop", () => {
  test("completing a nag tickler stops it from ever being returned by checkTicklers again", () => {
    const t = makeTickler({ title: "nag-complete-ends-loop", nag: { every: "1h" } });
    createTickler(t);

    checkTicklers(); // fire once
    completeTickler(t.id);

    const db = new Database(TEST_DB);
    db.prepare("UPDATE ticklers SET last_fired_at = @t WHERE id = @id").run({
      id: t.id,
      t: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    db.close();

    const after = checkTicklers();
    assert.ok(!after.some((r) => r.id === t.id), "a completed nag tickler must not fire again — status='pending' already excludes it");
  });
});

describe("nag: snooze pauses then resumes at the new due", () => {
  test("snooze pushes due to the future (not returned) then fires exactly once due passes, nagFireCount unaffected by the pause", () => {
    const t = makeTickler({ title: "nag-snooze-pause-resume", nag: { every: "4h" } });
    createTickler(t);

    checkTicklers(); // fire once, count:1
    const beforeSnooze = getTickler(t.id);
    assert.equal(beforeSnooze!.nagFireCount, 1);

    const future = new Date(Date.now() + 3600000).toISOString(); // 1h from now
    snoozeTickler(t.id, future);

    const paused = checkTicklers();
    assert.ok(!paused.some((r) => r.id === t.id), "must not be returned while due is in the future");

    const afterSnooze = getTickler(t.id);
    assert.equal(afterSnooze!.lastFiredAt, null, "snooze must reset lastFiredAt so the cadence resumes at the new due");
    assert.equal(afterSnooze!.nagFireCount, 1, "snooze must not reset the exhaustion budget");

    // Move due into the past to simulate the new due having passed.
    const db = new Database(TEST_DB);
    db.prepare("UPDATE ticklers SET due = @d WHERE id = @id").run({
      id: t.id,
      d: new Date(Date.now() - 60000).toISOString(),
    });
    db.close();

    const resumed = checkTicklers();
    const found = resumed.find((r) => r.id === t.id);
    assert.ok(found, "must fire exactly once the new due passes, treated as a fresh first fire");
    assert.equal(found!.nagFireCount, 2, "nagFireCount continues from where the pause started");
  });
});

describe("nag: migration — ensureNagColumns on a pre-#10 schema", () => {
  test("adds all four nag columns idempotently, old rows read back nag:null/lastFiredAt:null/nagFireCount:0", () => {
    const dbPath = tmpDbPath("migration");
    // Pre-#10 schema: has recur (from #9) but none of the nag columns.
    const oldSchema = `
      CREATE TABLE IF NOT EXISTS ticklers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        due TEXT NOT NULL,
        creator TEXT,
        tags TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        snoozed_until TEXT,
        recur TEXT
      )
    `;
    const db = new Database(dbPath);
    db.exec(oldSchema);
    db.prepare(
      "INSERT INTO ticklers (id, title, body, due, creator, tags, status, created_at) VALUES (@id, @title, @body, @due, @creator, @tags, @status, @created_at)"
    ).run({
      id: "pre-nag-row",
      title: "pre-existing tickler",
      body: "",
      due: new Date().toISOString(),
      creator: "test",
      tags: "[]",
      status: "pending",
      created_at: new Date().toISOString(),
    });

    const columnsBefore = db.prepare("PRAGMA table_info(ticklers)").all() as { name: string }[];
    for (const col of ["nag_every", "nag_max", "last_fired_at", "nag_fire_count"]) {
      assert.ok(!columnsBefore.some((c) => c.name === col), `old schema must not already have ${col}`);
    }

    ensureNagColumns(db);
    const columnsAfter = db.prepare("PRAGMA table_info(ticklers)").all() as { name: string }[];
    for (const col of ["nag_every", "nag_max", "last_fired_at", "nag_fire_count"]) {
      assert.ok(columnsAfter.some((c) => c.name === col), `${col} must exist after migration`);
    }

    const row = db.prepare("SELECT * FROM ticklers WHERE id = @id").get({ id: "pre-nag-row" }) as Record<string, unknown>;
    assert.equal(row.nag_every, null);
    assert.equal(row.nag_max, null);
    assert.equal(row.last_fired_at, null);
    assert.equal(row.nag_fire_count, 0, "DEFAULT 0 must apply to a backfilled column on an existing row");

    assert.doesNotThrow(() => ensureNagColumns(db), "must be idempotent on an already-migrated DB");

    db.close();
    rmDb(dbPath);
  });
});

describe("nag: completeTickler + recur composition", () => {
  test("a nag+recur successor copies the nag rule but resets lastFiredAt/nagFireCount to a fresh cycle", () => {
    // `resolveRecurForCreate` sets the series anchor completeTickler's successor scheduling
    // requires — a recur that never went through it (a bare `{ freq, tz }`) throws.
    const created = resolveRecurForCreate(
      { freq: "daily", tz: "America/Phoenix" },
      new Date(Date.now() - 3600000).toISOString()
    );
    const t = makeTickler({
      title: "nag-recur-successor",
      recur: created.recur,
      due: created.due,
      nag: { every: "1h", max: 5 },
    });
    createTickler(t);

    checkTicklers(); // fire once so the original has nagFireCount:1
    const original = getTickler(t.id);
    assert.equal(original!.nagFireCount, 1);

    const result = completeTickler(t.id);
    assert.ok(result.nextId, "a recurring tickler must schedule a successor");

    const successor = getTickler(result.nextId!);
    assert.ok(successor);
    assert.deepEqual(successor!.nag, { every: "1h", max: 5 }, "the nag rule must persist to the successor");
    assert.equal(successor!.lastFiredAt, null, "the successor must start a fresh nag cycle");
    assert.equal(successor!.nagFireCount, 0, "the successor's fire count must not inherit the prior occurrence's history");
  });
});

describe("nag: claimNagFire guard against a stale snapshot (the genuine race)", () => {
  test("a snapshot read before a concurrent exhaustion-bump returns null and makes no further change", () => {
    const t = makeTickler({ title: "nag-claim-stale-exhausted", nag: { every: "1h", max: 1 } });
    createTickler(t);

    // Read a genuinely-eligible candidate.
    const candidate = getTickler(t.id)!;
    assert.equal(candidate.lastFiredAt, null);

    // A second, independent connection mutates the live row to already-exhausted — simulating
    // a concurrent process claiming this tickler's only allowed fire between this test's read
    // and its own claim attempt.
    const rawConn = new Database(TEST_DB);
    rawConn.prepare("UPDATE ticklers SET last_fired_at = @t, nag_fire_count = 1 WHERE id = @id").run({
      id: t.id,
      t: new Date().toISOString(),
    });
    rawConn.close();

    const now = new Date().toISOString();
    const result = claimNagFire(candidate, now);
    assert.equal(result, null, "a stale candidate snapshot must be rejected once the live row is exhausted");

    const persisted = getTickler(t.id);
    assert.equal(persisted!.nagFireCount, 1, "the concurrent mutation's own write must be the only change — no double-count");
  });

  test("a snapshot read before a concurrent snooze (due moved to the future) returns null", () => {
    const t = makeTickler({ title: "nag-claim-stale-snoozed", nag: { every: "1h" } });
    createTickler(t);

    const candidate = getTickler(t.id)!;
    assert.equal(candidate.lastFiredAt, null);

    // Simulate a snooze landing after the read: due moves to the future.
    const rawConn = new Database(TEST_DB);
    rawConn.prepare("UPDATE ticklers SET due = @d WHERE id = @id").run({
      id: t.id,
      d: new Date(Date.now() + 3600000).toISOString(),
    });
    rawConn.close();

    const now = new Date().toISOString();
    const result = claimNagFire(candidate, now);
    assert.equal(result, null, "a stale candidate must not fire a tickler that was just pushed into the future");

    const persisted = getTickler(t.id);
    assert.equal(persisted!.lastFiredAt, null, "no fire must be recorded against a snoozed-away tickler");
  });

  test("claiming the same fresh candidate twice in a row: only the first succeeds", () => {
    const t = makeTickler({ title: "nag-claim-double-claim", nag: { every: "1h" } });
    createTickler(t);

    const candidate = getTickler(t.id)!;
    const now = new Date().toISOString();

    const first = claimNagFire(candidate, now);
    assert.ok(first, "the first claim against a fresh candidate must succeed");
    assert.equal(first!.nagFireCount, 1);

    // Reuses the now-stale original snapshot — its lastFiredAt no longer matches the live row.
    const second = claimNagFire(candidate, now);
    assert.equal(second, null, "reusing a stale snapshot for a second claim must fail");

    const persisted = getTickler(t.id);
    assert.equal(persisted!.nagFireCount, 1, "exactly one fire must be recorded");
  });
});

describe("nag: tickler_list never advances nag state", () => {
  test("repeated listTicklers calls on a due nag tickler leave lastFiredAt/nagFireCount untouched", () => {
    const t = makeTickler({ title: "nag-list-no-advance", nag: { every: "1h" } });
    createTickler(t);

    for (let i = 0; i < 3; i++) {
      const results = listTicklers({ status: "pending" });
      const found = results.find((r) => r.id === t.id);
      assert.ok(found);
      assert.equal(found!.lastFiredAt, null);
      assert.equal(found!.nagFireCount, 0);
    }

    const persisted = getTickler(t.id);
    assert.equal(persisted!.lastFiredAt, null);
    assert.equal(persisted!.nagFireCount, 0);
  });
});

describe("nag: full round trip through all four columns", () => {
  test("createTickler -> getTickler round-trips nag/lastFiredAt/nagFireCount", () => {
    const t = makeTickler({
      title: "nag-roundtrip",
      nag: { every: "3h", max: 7 },
      lastFiredAt: new Date(Date.now() - 1000).toISOString(),
      nagFireCount: 2,
    });
    createTickler(t);

    const found = getTickler(t.id);
    assert.ok(found);
    assert.deepEqual(found!.nag, { every: "3h", max: 7 });
    assert.equal(found!.lastFiredAt, t.lastFiredAt);
    assert.equal(found!.nagFireCount, 2);
  });

  test("runMigration's legacy-JSON import path: rows with no nag data read back nag:null, nagFireCount:0", async () => {
    const { runMigration } = await import("../src/store.js");
    const dbPath = tmpDbPath("legacy-import");
    const jsonPath = path.join(os.tmpdir(), `ticklers-legacy-nag-${crypto.randomUUID()}.json`);
    const legacyTickler = {
      id: crypto.randomUUID(),
      title: "legacy no-nag row",
      body: "",
      due: new Date(Date.now() + 86400000).toISOString(),
      tags: [],
      creator: "test",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      recur: null,
      // Deliberately omits nag/lastFiredAt/nagFireCount — a genuinely pre-#10 legacy row.
    };
    fs.writeFileSync(jsonPath, JSON.stringify({ ticklers: [legacyTickler] }));

    runMigration(dbPath, jsonPath);

    const db = new Database(dbPath);
    const row = db.prepare("SELECT * FROM ticklers WHERE title = ?").get("legacy no-nag row") as Record<string, unknown>;
    assert.ok(row, "the legacy row must have been imported");
    assert.equal(row.nag_every, null);
    assert.equal(row.nag_max, null);
    assert.equal(row.last_fired_at, null);
    assert.equal(row.nag_fire_count, 0);
    db.close();
    rmDb(dbPath);
    try { fs.unlinkSync(jsonPath); } catch { /* ignore */ }
    try { fs.unlinkSync(jsonPath + ".migrated"); } catch { /* ignore */ }
  });
});

// --- CLI / MCP parameter validation -----------------------------------------------------
// The CLI's own process boundary is where --nag/--nag-max validation is observable end to
// end, mirroring test/cli.test.ts's --recur validation tests. The MCP handler shares the
// exact same parseDuration/positive-integer checks (see src/mcp.ts), so these also cover
// that logic; zod itself already guarantees `.int().min(1)` for nag.max at the MCP layer.

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const CLI_TEST_DB = tmpDbPath("cli-validation");

function cli(args: string): string {
  return execSync(`node "${CLI}" ${args}`, {
    env: { ...process.env, TICKLER_DB_PATH: CLI_TEST_DB },
    encoding: "utf-8",
  });
}

after(() => rmDb(CLI_TEST_DB));

describe("nag: CLI validation", () => {
  test("a well-formed --nag with --nag-max creates a nag tickler", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const out = cli(`create "nag CLI valid" --due "${due}" --nag "1d" --nag-max 3`);
    assert.match(out, /Created:/);
    assert.match(out, /Nag:\s+every 1d \(max 3\)/);
  });

  test("an invalid --nag duration is rejected", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "nag CLI bad duration" --due "${due}" --nag "notaduration"`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "an invalid --nag duration must be rejected");
  });

  test("a non-integer --nag-max is rejected", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "nag CLI bad max decimal" --due "${due}" --nag "1d" --nag-max 2.5`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "a decimal --nag-max must be rejected, not truncated");
  });

  test("a negative or zero --nag-max is rejected", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "nag CLI bad max zero" --due "${due}" --nag "1d" --nag-max 0`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "a zero --nag-max must be rejected");
  });

  test("--nag-max without --nag is rejected", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "nag CLI max without nag" --due "${due}" --nag-max 3`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "--nag-max requires --nag");
  });

  test("--no-mark-fired is accepted by the check command", () => {
    // No due items expected in this isolated DB — just confirm the flag is recognized and the
    // command runs (exit 0, no due items).
    const out = cli("check --no-mark-fired");
    assert.match(out, /No past-due ticklers/);
  });
});
