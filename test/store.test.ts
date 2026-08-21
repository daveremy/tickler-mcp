import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import Database from "better-sqlite3";

/** A unique temp DB path. Declared as a hoisted function so `TEST_DB` can use it. */
function tmpDbPath(label: string): string {
  return path.join(os.tmpdir(), `tickler-${label}-${crypto.randomUUID()}.db`);
}

/** Remove a SQLite DB and its WAL sidecars. */
function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// Each test suite gets its own DB file via env var
const TEST_DB = tmpDbPath("test");
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
  normalizeDue,
  normalizeStoredDueDates,
  MAX_LOGGED_ROWS,
  TICKLERS_SCHEMA_SQL,
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

after(() => rmDb(TEST_DB));

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
    const migrationDb = tmpDbPath("migration");
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
    rmDb(migrationDb);
    try { fs.unlinkSync(legacyJson + ".migrated"); } catch { /* ignore */ }
  });

  test("is a no-op when JSON file does not exist", () => {
    const migrationDb = tmpDbPath("noop");
    const nonExistent = path.join(os.tmpdir(), `nonexistent-${crypto.randomUUID()}.json`);
    // Should not throw
    runMigration(migrationDb, nonExistent);
    // DB may or may not be created — just verify no crash
    rmDb(migrationDb);
  });

  test("skips corrupted JSON and leaves file intact", () => {
    const migrationDb = tmpDbPath("corrupt");
    const corruptedJson = path.join(os.tmpdir(), `ticklers-corrupted-${crypto.randomUUID()}.json`);
    fs.writeFileSync(corruptedJson, "{ not valid json");

    // Should not throw — logs warning and returns
    runMigration(migrationDb, corruptedJson);

    // File should still exist (was not renamed or deleted)
    assert.ok(fs.existsSync(corruptedJson), "corrupted file should be left intact");
    assert.ok(!fs.existsSync(corruptedJson + ".migrated"), "should NOT be renamed");

    // Clean up
    fs.unlinkSync(corruptedJson);
    rmDb(migrationDb);
  });
});

/**
 * Issue #3 — `due` was stored exactly as supplied while `checkTicklers` compares
 * it lexicographically against a UTC-Z `now`, so any offset or naive timestamp
 * fired up to a full offset early.
 *
 * Every assertion below is timezone-independent on purpose. Under `TZ=UTC` a
 * naive-vs-UTC-Z comparison is identical on both sides, so a test written around
 * a hardcoded `-07:00` fixture would pass without proving anything. Expected
 * values are therefore *constructed* — from local-time constructors, or by
 * rendering a known instant into a fixed offset frame — never hardcoded.
 */
/** Same format as `CANONICAL_DUE_GLOB` in src/store.ts — change them together. */
const CANONICAL_UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Render `instant` as a wall-clock string carrying an explicit `±HH:00` offset. */
function inOffset(instant: Date, offsetHours: number): string {
  const shifted = new Date(instant.getTime() + offsetHours * 3600_000);
  const sign = offsetHours < 0 ? "-" : "+";
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.abs(offsetHours))}:00`
  );
}

/** Render `d` as a naive local timestamp — no offset, no `Z`. */
function naiveLocal(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * A raw handle with the real schema, bypassing `openDb`'s backfill — otherwise
 * the backfill would normalize seeded rows and hide whether the write path under
 * test normalizes on its own.
 */
function rawDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(TICKLERS_SCHEMA_SQL);
  return db;
}

/**
 * Collect everything `fn` writes to stderr. The backfill's reporting is a
 * behaviour with a contract, not decoration, so it is asserted rather than
 * eyeballed — and capturing it also keeps the test output readable.
 */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/**
 * Same shape as `OFFSET_SUFFIX` in src/store.ts — change them together. Spelled
 * out here rather than imported, for the same reason `CANONICAL_UTC_Z` above is:
 * a post-condition asserted with the implementation's own predicate cannot
 * notice the predicate itself being widened.
 */
const OFFSET_SUFFIX_RE = /[+-]\d{2}:\d{2}$/;

/**
 * An instant a day out with no sub-second component — naive and offset
 * spellings carry no milliseconds, so a fixture that had them would not
 * round-trip.
 */
function futureInstant(msFromNow = 86400_000): Date {
  const d = new Date(Date.now() + msFromNow);
  d.setMilliseconds(0);
  return d;
}

describe("store: due normalization (issue #3)", () => {
  test("REGRESSION: a tickler due 2h out with a -07:00 offset does not fire", () => {
    const twoHoursOut = new Date(Date.now() + 2 * 3600_000);
    const due = inOffset(twoHoursOut, -7);

    // Guard against a vacuous pass: this input is only a meaningful regression
    // test if the shipped string comparison would actually have fired it. If
    // this assertion ever fails the test below proves nothing, so it must fail
    // loudly rather than quietly go green.
    assert.ok(
      due < new Date().toISOString(),
      `test input is not exercising the bug: "${due}" does not sort before now`
    );

    const t = makeTickler({ title: "regression-offset-future", due });
    createTickler(t);

    const fired = checkTicklers();
    assert.ok(
      !fired.some((x) => x.id === t.id),
      "a tickler 2h in the future must not be returned by checkTicklers()"
    );
  });

  /**
   * The property the whole fix reduces to: **membership in `checkTicklers()`
   * depends on the instant, never on how the instant was spelled.**
   *
   * Asserted as a grid rather than as one more example, because examples were
   * hiding a gap. Absence was covered in the offset frame (the regression test
   * above), presence only in the UTC-Z frame — so a regression that dropped
   * *every* offset-carrying row would have passed both: absence is what the
   * first one wants, and the second never supplies an offset.
   *
   * The sign of the offset matters too, and this is the subtler half. A past-due
   * instant rendered at a NEGATIVE offset produces a string that sorts even
   * earlier, so it fires with or without normalization — a positive control that
   * proves nothing. `+05:00` is the discriminating case: the same past instant
   * renders as a string sorting AFTER a UTC-Z now, so an unnormalized store
   * fails to fire it. Each row below carries the guard that says which of the
   * two it is, so a fixture that stops exercising the bug fails loudly instead
   * of going quietly green.
   *
   * Everything here asserts `checkTicklers()` directly. Delivery timing is not
   * observed: a test that waits for a tickler to arrive exercises the comparison
   * and the notification path together, and a pass proves neither (issue #6,
   * where a LATE fire was reported that this comparison cannot produce).
   */
  describe("checkTicklers membership follows the instant, not the spelling", () => {
    const spellings: [string, (d: Date) => string][] = [
      ["UTC-Z", (d) => d.toISOString()],
      ["-07:00", (d) => inOffset(d, -7)],
      ["+05:00", (d) => inOffset(d, 5)],
      ["naive local", naiveLocal],
    ];
    const deltas: [string, number][] = [
      ["2h past", -2 * 3600_000],
      ["2h future", +2 * 3600_000],
    ];

    /** Would the RAW string have sorted the wrong way, i.e. does this cell detect the bug? */
    const discriminates = (due: string, shouldFire: boolean) =>
      due <= new Date().toISOString() !== shouldFire;

    for (const [spelling, render] of spellings) {
      for (const [when, delta] of deltas) {
        const shouldFire = delta < 0;
        test(`${when}, written as ${spelling} — ${shouldFire ? "fires" : "does not fire"}`, () => {
          const instant = new Date(Date.now() + delta);
          instant.setMilliseconds(0);
          const due = render(instant);

          const t = makeTickler({ title: `grid-${spelling}-${when}`, due });
          createTickler(t);

          assert.equal(
            checkTicklers().some((x) => x.id === t.id),
            shouldFire,
            `${spelling} spelling of an instant ${when} must ${shouldFire ? "" : "not "}fire ` +
              `(raw string ${discriminates(due, shouldFire) ? "would" : "would not"} have mis-sorted)`
          );
        });
      }
    }

    test("the grid contains a cell that detects the bug in each direction", () => {
      // Without this the grid could quietly degrade into eight consistency
      // checks that a fully un-normalized store would also pass. Under TZ=UTC
      // the naive spelling is identical to UTC-Z and detects nothing, which is
      // exactly the kind of erosion this guards against.
      const detected = new Set<boolean>();
      for (const [, render] of spellings) {
        for (const [, delta] of deltas) {
          const instant = new Date(Date.now() + delta);
          instant.setMilliseconds(0);
          if (discriminates(render(instant), delta < 0)) detected.add(delta < 0);
        }
      }
      assert.ok(detected.has(false), "no cell would wrongly FIRE without normalization");
      assert.ok(detected.has(true), "no cell would wrongly NOT fire without normalization");
    });
  });

  test("naive, offset and UTC-Z spellings of one instant round-trip identically", () => {
    const instant = new Date(Date.now() + 5 * 3600_000);
    instant.setMilliseconds(0); // naive/offset forms carry no milliseconds

    const spellings = {
      utcZ: instant.toISOString(),
      offsetMinus7: inOffset(instant, -7),
      offsetPlus5: inOffset(instant, 5),
      naive: naiveLocal(instant),
    };

    const stored = Object.entries(spellings).map(([label, due]) => {
      const t = makeTickler({ title: `roundtrip-${label}`, due });
      createTickler(t);
      return [label, getTickler(t.id)!.due] as const;
    });

    for (const [label, value] of stored) {
      assert.equal(value, instant.toISOString(), `${label} should store the same instant`);
    }
  });

  test("createTickler stores canonical UTC-Z", () => {
    const t = makeTickler({ title: "canonical-create", due: inOffset(new Date(), -7) });
    createTickler(t);
    assert.match(getTickler(t.id)!.due, CANONICAL_UTC_Z);
  });

  test("snoozeTickler normalizes its own write path", () => {
    const t = makeTickler({ title: "canonical-snooze" });
    createTickler(t);

    const target = new Date(Date.now() + 3 * 86400_000);
    target.setMilliseconds(0);
    snoozeTickler(t.id, inOffset(target, -7));

    const found = getTickler(t.id)!;
    assert.match(found.due, CANONICAL_UTC_Z);
    assert.equal(found.due, target.toISOString());
  });

  test("the JSON import path normalizes on insert", () => {
    // Uses a raw handle rather than a DB path: `openDb` runs the backfill, which
    // would normalize these rows even if the insert path did not, hiding the
    // very thing this test exists to prove.
    const dbPath = tmpDbPath("import-normalize");
    const jsonPath = path.join(os.tmpdir(), `ticklers-import-${crypto.randomUUID()}.json`);

    const instant = new Date(Date.now() + 86400_000);
    instant.setMilliseconds(0);
    const legacy = makeTickler({ title: "import-offset", due: inOffset(instant, -7) });
    fs.writeFileSync(jsonPath, JSON.stringify({ ticklers: [legacy] }));

    const db = rawDb(dbPath);
    runMigration(db, jsonPath);

    const row = db.prepare("SELECT due FROM ticklers WHERE id = ?").get(legacy.id) as { due: string };
    assert.equal(row.due, instant.toISOString(), "import must store UTC-Z, not the raw offset string");
    db.close();

    rmDb(dbPath);
    try { fs.unlinkSync(jsonPath + ".migrated"); } catch { /* ignore */ }
  });

  test("createTickler throws on an unparseable due", () => {
    const t = makeTickler({ title: "bad-create", due: "not-a-date" });
    assert.throws(() => createTickler(t), RangeError);
    assert.equal(getTickler(t.id), undefined, "nothing should have been stored");
  });

  test("snoozeTickler throws on an unparseable due", () => {
    const t = makeTickler({ title: "bad-snooze" });
    createTickler(t);
    const before = getTickler(t.id)!.due;

    assert.throws(() => snoozeTickler(t.id, "tomorrow-ish"), RangeError);
    assert.equal(getTickler(t.id)!.due, before, "due should be untouched after a rejected snooze");
  });

  test("normalizeDue rejects an impossible calendar date", () => {
    // `new Date(2026, 1, 30)` silently rolls over to March 2 instead of throwing.
    assert.throws(() => normalizeDue("2026-02-30"), RangeError);
  });

  test("naive input is read as local time, not UTC", () => {
    const naive = "2026-08-17T09:00:00";
    const expected = new Date(2026, 7, 17, 9, 0, 0).toISOString();
    assert.equal(normalizeDue(naive), expected);
  });

  test("date-only input is read as local midnight", () => {
    // ECMA-262 parses a bare date as UTC midnight; west of Greenwich that would
    // fire the reminder the previous evening.
    assert.equal(normalizeDue("2026-08-17"), new Date(2026, 7, 17).toISOString());
  });

  describe("backfill of rows stored in a legacy format", () => {
    test("normalizeStoredDueDates rewrites legacy rows and leaves canonical ones alone", () => {
      const dbPath = tmpDbPath("backfill-unit");
      const db = rawDb(dbPath);

      const instant = new Date(Date.now() + 86400_000);
      instant.setMilliseconds(0);
      const canonical = new Date(Date.now() + 2 * 86400_000).toISOString();

      const insert = db.prepare(
        "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      );
      insert.run("legacy-offset", "legacy-offset", inOffset(instant, -7), canonical);
      insert.run("legacy-naive", "legacy-naive", naiveLocal(instant), canonical);
      insert.run("already-canonical", "already-canonical", canonical, canonical);
      insert.run("unparseable", "unparseable", "definitely not a date", canonical);

      const changed = normalizeStoredDueDates(db);
      assert.equal(changed, 2, "only the two legacy rows should have been rewritten");

      const due = (id: string) =>
        (db.prepare("SELECT due FROM ticklers WHERE id = ?").get(id) as { due: string }).due;

      assert.equal(due("legacy-offset"), instant.toISOString());
      assert.equal(due("legacy-naive"), instant.toISOString());
      assert.equal(due("already-canonical"), canonical);
      assert.equal(due("unparseable"), "definitely not a date", "unparseable rows are left, not dropped");

      // Idempotent: a second pass must be a no-op.
      assert.equal(normalizeStoredDueDates(db), 0);

      db.close();
      rmDb(dbPath);
    });

    /**
     * Issue #6 — the migration has to be able to prove it worked. Counting rows
     * per stored shape before and after, and asserting the offset-suffixed count
     * reaches zero, is the verification; "the backfill did not throw" is not.
     */
    describe("reporting (issue #6)", () => {
      /**
       * Seed a known mix, run the backfill, hand the assertions its stderr.
       *
       * Takes the assertion body rather than returning a handle so that the
       * close and unlink sit in a `finally`: with teardown after the asserts,
       * every failing test leaks a connection and an orphaned temp DB — and a
       * failing test is exactly when that happens.
       */
      function backfillWith(
        label: string,
        seed: (insert: Database.Statement, created: string) => void,
        body: (lines: string[], db: Database.Database) => void
      ): void {
        const dbPath = tmpDbPath(label);
        const db = rawDb(dbPath);
        try {
          const created = new Date().toISOString();
          const insert = db.prepare(
            "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
          );
          seed(insert, created);
          body(captureStderr(() => normalizeStoredDueDates(db)), db);
        } finally {
          db.close();
          rmDb(dbPath);
        }
      }

      const find = (lines: string[], needle: string) =>
        lines.find((l) => l.includes(needle));

      test("counts rows by shape before, and reports zero offset-suffixed after", () => {
        const instant = futureInstant();
        const canonical = instant.toISOString();

        backfillWith(
          "report-counts",
          (insert, created) => {
            insert.run("off-1", "off-1", inOffset(instant, -7), created);
            insert.run("off-2", "off-2", inOffset(instant, 5), created);
            insert.run("utc-no-ms", "utc-no-ms", canonical.replace(".000Z", "Z"), created);
            insert.run("naive-1", "naive-1", naiveLocal(instant), created);
            insert.run("canonical", "canonical", canonical, created);
          },
          (lines, db) => {
            const before = find(lines, "due backfill —");
            assert.ok(before, "the backfill must report what it found");
            assert.match(before, /4 legacy row\(s\)/);
            assert.match(before, /offset-suffixed 2/);
            assert.match(before, /non-canonical UTC 1/);
            assert.match(before, /naive 1/);

            const after = find(lines, "due backfill complete");
            assert.ok(after, "the backfill must report what it left behind");
            assert.match(after, /4 rewritten/);
            assert.match(after, /0 offset-suffixed remaining/);
            assert.match(after, /0 non-canonical remaining/);

            assert.ok(
              !find(lines, "MIGRATION INCOMPLETE"),
              "a clean migration must not claim to be incomplete"
            );

            // The counts are a claim about the DB, so check the DB too — a
            // report agreeing with itself is not evidence.
            const stillOffset = (db.prepare("SELECT due FROM ticklers").all() as { due: string }[])
              .filter((r) => OFFSET_SUFFIX_RE.test(r.due));
            assert.equal(stillOffset.length, 0, "no row may still carry a UTC offset");
          }
        );
      });

      test("names every row whose timezone was assumed rather than read", () => {
        const instant = futureInstant();

        backfillWith(
          "report-naive",
          (insert, created) => {
            insert.run("guessed", "guessed", naiveLocal(instant), created);
            insert.run("known", "known", inOffset(instant, -7), created);
          },
          (lines) => {
            const attributed = find(lines, "guessed");
            assert.ok(attributed, "a row read as local time must be named, not just counted");
            assert.match(attributed, /no timezone/);
            assert.ok(
              attributed.includes(instant.toISOString()),
              "the line must say what the guess resolved to"
            );

            // The offset row was read, not guessed at, so it must NOT be reported
            // as an assumption — otherwise the signal stops meaning anything.
            assert.ok(!find(lines, "known"), "a row with an explicit offset is not a guess");
          }
        );
      });

      test("an unrepairable offset row leaves the migration incomplete, loudly", () => {
        const bad = "2026-13-45T00:00:00-07:00"; // offset-suffixed AND unparseable
        assert.throws(
          () => normalizeDue(bad),
          RangeError,
          "test input must actually be unrepairable or this proves nothing"
        );

        const instant = futureInstant();

        backfillWith(
          "report-incomplete",
          (insert, created) => {
            insert.run("stuck", "stuck", bad, created);
            insert.run("fine", "fine", inOffset(instant, -7), created);
          },
          (lines, db) => {
            const after = find(lines, "due backfill complete");
            assert.ok(after);
            assert.match(after, /1 rewritten/);
            assert.match(after, /1 offset-suffixed remaining/);

            const alarm = find(lines, "MIGRATION INCOMPLETE");
            assert.ok(alarm, "a surviving offset row must not look like a successful migration");
            assert.match(alarm, /1 row\(s\) still carry a UTC offset/);
            assert.ok(find(lines, "stuck"), "the row that could not be repaired must be named");

            // The repairable row was still repaired — partial success is not
            // rolled back just because one row could not be saved.
            const fine = db
              .prepare("SELECT due FROM ticklers WHERE id = 'fine'")
              .get() as { due: string };
            assert.equal(fine.due, instant.toISOString());
          }
        );
      });

      test("per-row logging is capped so a large legacy DB cannot flood stderr", () => {
        const extra = 5;
        const total = MAX_LOGGED_ROWS + extra;
        const base = futureInstant();
        base.setSeconds(0); // each row a distinct whole minute, so none collide

        backfillWith(
          "report-cap",
          (insert, created) => {
            for (let i = 0; i < total; i++) {
              const d = new Date(base.getTime() + i * 60_000);
              insert.run(`naive-${i}`, `naive-${i}`, naiveLocal(d), created);
            }
          },
          (lines) => {
            const perRow = lines.filter((l) => l.includes("has no timezone"));
            assert.equal(perRow.length, MAX_LOGGED_ROWS, "per-row attribution must stop at the cap");

            assert.ok(
              find(lines, `and ${extra} more`),
              "withheld rows must be acknowledged, not silently dropped"
            );

            // Truncating the attribution must not truncate the counts.
            const before = find(lines, "due backfill —");
            assert.ok(before);
            assert.match(before, new RegExp(`${total} legacy row\\(s\\)`));
            assert.match(before, new RegExp(`naive ${total}`));

            const after = find(lines, "due backfill complete");
            assert.ok(after);
            assert.match(after, new RegExp(`${total} rewritten`));
          }
        );
      });

      test("a rolled-back repair reports nothing — no log may claim a reverted write", () => {
        // The report is emitted after the transaction commits, so a rollback
        // must leave no "rewritten" claim behind. Driven by holding the write
        // lock from a second connection, the same way the busy test above does.
        const dbPath = tmpDbPath("report-rollback");
        const owner = rawDb(dbPath);
        const other = new Database(dbPath);
        other.pragma("busy_timeout = 50");

        try {
          const legacy = inOffset(futureInstant(), -7);
          owner
            .prepare(
              "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
            )
            .run("blocked", "blocked", legacy, new Date().toISOString());

          owner.exec("BEGIN IMMEDIATE");
          let lines: string[];
          try {
            lines = captureStderr(() => normalizeStoredDueDates(other));
          } finally {
            owner.exec("ROLLBACK");
          }

          assert.ok(!find(lines, "rewritten"), "a repair that never committed must not claim one");
          assert.ok(!find(lines, "due backfill —"), "nor report counts for work it did not do");
          assert.ok(find(lines, "backfill skipped"), "it must say it gave up, not stay silent");
        } finally {
          other.close();
          owner.close();
          rmDb(dbPath);
        }
      });
    });

    test("a backfill blocked by another writer fails safe instead of throwing", () => {
      // The backfill's contract is that it never throws: it runs inside openDb,
      // so an exception here makes the store unopenable for that process. With
      // 16 MCP processes sharing the file, losing the write lock is routine, not
      // exotic. Exercises the real function rather than a copy of its SQL.
      const dbPath = tmpDbPath("backfill-busy");
      const owner = rawDb(dbPath);

      const legacy = inOffset(new Date(Date.now() + 86400_000), -7);
      owner.prepare(
        "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      ).run("contended", "contended", legacy, new Date().toISOString());

      // A second connection, as a second process would be.
      const other = new Database(dbPath);
      other.pragma("busy_timeout = 50"); // fail fast instead of the 5s default

      owner.exec("BEGIN IMMEDIATE"); // hold the write lock
      try {
        // Readers are not blocked, so the probe still finds work to do — the
        // function reaches the transaction and cannot acquire the lock.
        assert.equal(
          normalizeStoredDueDates(other),
          0,
          "must report no work done rather than throwing"
        );
      } finally {
        owner.exec("ROLLBACK");
      }

      // Left untouched, so the next open retries it — self-healing, not skipped.
      const after = (
        owner.prepare("SELECT due FROM ticklers WHERE id = 'contended'").get() as { due: string }
      ).due;
      assert.equal(after, legacy, "the row must survive for a later attempt");

      // And a later attempt, uncontended, does repair it.
      assert.equal(normalizeStoredDueDates(other), 1);

      other.close();
      owner.close();
      rmDb(dbPath);
    });

    test("a snooze that lands before the backfill is left alone", () => {
      // Not a test of the `AND due = @old` guard — see the note on that guard in
      // src/store.ts. Once a concurrent snooze has written a canonical value the
      // row stops being a candidate, so the function returns before it ever
      // reaches the UPDATE. That is the whole point: the common ordering is
      // handled by the candidate predicate, not by the guard.
      const dbPath = tmpDbPath("backfill-snoozed");
      const db = rawDb(dbPath);

      const legacy = inOffset(new Date(Date.now() + 86400_000), -7);
      const snoozedTo = new Date(Date.now() + 9 * 86400_000).toISOString();

      db.prepare(
        "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      ).run("raced", "raced", legacy, new Date().toISOString());

      db.prepare("UPDATE ticklers SET due = ? WHERE id = 'raced'").run(snoozedTo);

      assert.equal(normalizeStoredDueDates(db), 0, "canonical row is not a candidate");

      const due = (db.prepare("SELECT due FROM ticklers WHERE id = 'raced'").get() as { due: string }).due;
      assert.equal(due, snoozedTo, "the snooze must survive");

      db.close();
      rmDb(dbPath);
    });

    test("runs automatically when the store opens a DB holding legacy rows", () => {
      const dbPath = tmpDbPath("backfill-integration");
      const instant = new Date(Date.now() + 2 * 3600_000);
      instant.setMilliseconds(0);

      const seed = rawDb(dbPath);
      seed.prepare(
        "INSERT INTO ticklers (id, title, due, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      ).run("legacy-on-open", "legacy-on-open", inOffset(instant, -7), new Date().toISOString());
      seed.close();

      const previous = process.env.TICKLER_DB_PATH;
      process.env.TICKLER_DB_PATH = dbPath; // path change forces getDb() to re-open
      try {
        const found = getTickler("legacy-on-open");
        assert.ok(found, "seeded row should be readable");
        assert.equal(found.due, instant.toISOString(), "opening the store should have normalized it");
        assert.ok(
          !checkTicklers().some((t) => t.id === "legacy-on-open"),
          "and it should no longer fire early"
        );
      } finally {
        process.env.TICKLER_DB_PATH = previous;
        getTickler("restore-connection"); // re-point the cached handle at TEST_DB
      }

      rmDb(dbPath);
    });
  });

  test("import with an unparseable due keeps the source JSON for recovery", () => {
    const dbPath = tmpDbPath("import-bad");
    const jsonPath = path.join(os.tmpdir(), `ticklers-bad-${crypto.randomUUID()}.json`);

    const good = makeTickler({ title: "import-good" });
    const bad = makeTickler({ title: "import-bad", due: "whenever" });
    fs.writeFileSync(jsonPath, JSON.stringify({ ticklers: [good, bad] }));

    runMigration(dbPath, jsonPath);

    const db = new Database(dbPath);
    const row = db.prepare("SELECT due FROM ticklers WHERE id = ?").get(bad.id);
    assert.equal(row, undefined, "the unparseable row must not be stored");
    db.close();

    assert.ok(fs.existsSync(jsonPath), "source JSON must be left in place for manual recovery");
    assert.ok(!fs.existsSync(jsonPath + ".migrated"), "and must NOT be renamed");

    fs.unlinkSync(jsonPath);
    rmDb(dbPath);
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
