import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { Tickler, Nag, NotifyChannel } from "./types.js";
import type { Recur } from "./recur.js";
import { formatRecur, nextFutureOccurrence } from "./recur.js";
import { parseDuration } from "./duration.js";

// Resolved lazily at each call so tests can set TICKLER_DB_PATH before importing.
export function getDbPath(): string {
  return (
    process.env.TICKLER_DB_PATH ??
    path.join(os.homedir(), "obsidian", "data", "ticklers.db")
  );
}

function getLegacyJsonPath(): string {
  return (
    process.env.TICKLER_PATH ??
    path.join(os.homedir(), ".tickler", "ticklers.json")
  );
}

/** Matched before `Date.parse`, which would read this shape as UTC midnight. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonicalize a due timestamp to UTC-Z (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
 *
 * Every write path funnels through here so the `due` TEXT column ever holds only
 * one spelling of an instant. `checkTicklers` compares `due` against
 * `new Date().toISOString()` using SQLite's lexicographic `<=`, which is a valid
 * instant comparison only when both sides share a frame of reference (issue #3).
 *
 * How each input shape is read — all three are deliberate choices, made here at
 * the write boundary while the author's intent is still available:
 *
 * - **Explicit offset or `Z`** (`2026-08-17T09:00:00-07:00`) — the instant it denotes.
 * - **Naive** (`2026-08-17T09:00:00`, no offset) — the author's *local* time.
 *   This is what `new Date()` already does, and it is the right reading: someone
 *   writing "09:00" means 09:00 where they are.
 * - **Date-only** (`2026-08-17`) — *local* midnight. ECMA-262 parses date-only
 *   forms as UTC midnight, which would contradict the naive rule above and, west
 *   of Greenwich, fire the reminder the previous evening. The CLI's `--due` help
 *   advertises `YYYY-MM-DD`, so this shape is not hypothetical.
 *
 * `due` is typed `unknown` rather than `string` because `runMigration` feeds it
 * values off an unvalidated `JSON.parse`, where the declared type is a claim
 * rather than a guarantee.
 *
 * @throws {RangeError} when `due` cannot be parsed. Failing loudly at write time
 * beats storing a string that mis-sorts silently forever.
 */
export function normalizeDue(due: unknown): string {
  if (typeof due !== "string") {
    throw new RangeError(
      `Invalid due date ${JSON.stringify(due)} — expected an ISO 8601 string.`
    );
  }

  const raw = due.trim();

  if (DATE_ONLY.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const localMidnight = new Date(year, month - 1, day);
    // `new Date(2026, 1, 30)` rolls over to March 2 rather than throwing, so an
    // impossible calendar date has to be rejected by reading the parts back.
    if (
      localMidnight.getFullYear() !== year ||
      localMidnight.getMonth() !== month - 1 ||
      localMidnight.getDate() !== day
    ) {
      throw new RangeError(`Invalid due date "${due}" — no such calendar date.`);
    }
    return localMidnight.toISOString();
  }

  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new RangeError(
      `Invalid due date "${due}". Use ISO 8601, e.g. 2026-04-01T09:00:00-07:00.`
    );
  }
  return new Date(ms).toISOString();
}

let _db: Database.Database | undefined;
let _dbPath: string | undefined;

function getDb(): Database.Database {
  const dbPath = getDbPath();

  // Re-initialize if env var changed (e.g., between test files)
  if (_db && _dbPath === dbPath) return _db;

  if (_db) {
    _db.close();
    _db = undefined;
  }

  // Ensure the parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = openDb(dbPath);
  _dbPath = dbPath;
  runMigration(_db, getLegacyJsonPath());

  return _db;
}

/**
 * Table definition. Exported so tests that need a raw handle — one that skips
 * the backfill below, in order to prove the write paths normalize on their own —
 * cannot drift from the real schema.
 */
export const TICKLERS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ticklers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    due TEXT NOT NULL,
    creator TEXT,
    notify TEXT NOT NULL DEFAULT 'agent',
    tags TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    snoozed_until TEXT,
    recur TEXT,
    nag_every TEXT,
    nag_max INTEGER,
    last_fired_at TEXT,
    nag_fire_count INTEGER NOT NULL DEFAULT 0
  )
`;

/**
 * Generic ADD-COLUMN-IF-MISSING guard for `ticklers` — idempotent, leaves existing data
 * untouched. `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists
 * without a newly-added column, so any column added after the schema first shipped needs
 * one of these. Extracted as a reusable helper (rather than one hardcoded per column) so a
 * sibling migration — issue #10 (nag) shares this exact need for its own new columns — can
 * call it directly instead of duplicating the PRAGMA/ALTER pair (issue #9 comment: "keep the
 * ADD-COLUMN guard generic so both branches merge cleanly").
 */
export function ensureColumn(db: Database.Database, columnName: string, sqlType: string): void {
  const columns = db.prepare("PRAGMA table_info(ticklers)").all() as { name: string }[];
  if (!columns.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ticklers ADD COLUMN ${columnName} ${sqlType}`);
  }
}

/** `recur`'s own instance of the generic guard above — kept as a named export since every
 * existing call site (openDb, runMigration, tests) already calls it by this name. */
export function ensureRecurColumn(db: Database.Database): void {
  ensureColumn(db, "recur", "TEXT");
}

/**
 * `nag`'s own instance of the generic guard above (issue #10). Stored as flat columns
 * rather than one JSON blob (unlike `recur`, which is genuinely nested) so `checkTicklers`
 * can filter out already-exhausted nag ticklers directly in SQL (`nag_max IS NULL OR
 * nag_fire_count < nag_max`) instead of materializing and discarding them in JS as
 * reminder history grows.
 */
export function ensureNagColumns(db: Database.Database): void {
  ensureColumn(db, "nag_every", "TEXT");
  ensureColumn(db, "nag_max", "INTEGER");
  ensureColumn(db, "last_fired_at", "TEXT");
  ensureColumn(db, "nag_fire_count", "INTEGER NOT NULL DEFAULT 0");
}

/** `notify`'s own instance of the generic guard above (tickler-mcp#11). NOT NULL DEFAULT
 * 'agent' so a pre-existing row — which predates the column and so the whole channel — reads
 * back as agent-delivered, exactly the behavior it was written under. */
export function ensureNotifyColumn(db: Database.Database): void {
  ensureColumn(db, "notify", "TEXT NOT NULL DEFAULT 'agent'");
}

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(TICKLERS_SCHEMA_SQL);
  ensureRecurColumn(db);
  ensureNagColumns(db);
  ensureNotifyColumn(db);

  normalizeStoredDueDates(db);

  return db;
}

/**
 * Canonical UTC-Z shape, exactly as `toISOString()` emits it. GLOB rather than
 * LIKE because GLOB is case-sensitive and can assert digits — LIKE would treat a
 * trailing lowercase `z` as already-canonical and skip a row that needs fixing.
 *
 * Kept in sync with `CANONICAL_UTC_Z` in `test/store.test.ts`, which asserts the
 * same shape as a JS regex. Two dialects, one format — change them together.
 *
 * Interpolated into the SQL below rather than bound as a parameter. That is safe
 * (module constant, no user input, no quote characters) and deliberate: SQLite
 * can only match a query against a partial index if the pattern is a literal, so
 * binding it would foreclose the escape hatch described on the function below.
 */
const CANONICAL_DUE_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

/**
 * A trailing `±HH:MM`. The backfill's post-condition is stated in terms of this
 * shape specifically, because it is the one that mis-sorts *silently*: it parses
 * fine, renders fine, and compares wrong. A surviving row of this shape is a
 * failed migration; a surviving unparseable row is merely bad input.
 */
const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;

/**
 * The legacy-row predicate, in one place. Three queries select on it — the
 * unlocked probe, the candidate read, and the post-condition read-back — and the
 * partial index documented on `normalizeStoredDueDates` below is only usable if
 * the WHERE text matches the index expression exactly. Three hand-copies could
 * drift out of index-eligibility and silently fall back to the O(N) scan the
 * note exists to avoid.
 */
const LEGACY_DUE_WHERE = `due NOT GLOB '${CANONICAL_DUE_GLOB}'`;

/**
 * Per-row attribution is capped so that a large legacy database cannot turn a
 * migration into an unbounded write to stderr. Only the row-by-row lines are
 * truncated — the counts always report in full. Rows beyond the cap are never
 * formatted, so the cap bounds the work as well as the output.
 *
 * Exported so the test asserting the cap reads the real value rather than a
 * mirrored copy that could drift and quietly make that test vacuous.
 */
export const MAX_LOGGED_ROWS = 20;

/**
 * An ISO 8601 date or date-time carrying no zone designator: `2026-08-17`,
 * `2026-08-17T09:00`, `2026-08-17T09:00:00`, `…:00.5`.
 *
 * Needed because "has no `Z` and no offset" is not the same claim as "is a
 * timestamp with no timezone" — `"definitely not a date"` satisfies the first
 * and none of the second. Without this the report counted junk as bare-naive and
 * announced it was "read as LOCAL time", which is false about those rows in the
 * one output whose entire job is to be accurate about what the migration did.
 */
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/** Shape a legacy `due` was stored in, for the before/after migration counts. */
type DueShape = "offset" | "utc" | "naive" | "unrecognized";

function classifyDue(due: string): DueShape {
  if (OFFSET_SUFFIX.test(due)) return "offset";
  if (due.endsWith("Z")) return "utc";
  if (NAIVE_TIMESTAMP.test(due)) return "naive";
  return "unrecognized";
}

/**
 * `unrecognized` is reported as its own thing rather than folded into either
 * neighbour, because for those rows we genuinely **do not know** whether a
 * timezone was read or assumed, and both available lies were tried first:
 *
 * - Calling them naive claims their timezone was assumed. False for the ones
 *   that carry a zone `Date.parse` understands — `Sun, 01 Mar 2026 09:00:00 GMT`,
 *   or an offset written without a colon as `+0500`.
 * - Leaving them out of the attribution claims their timezone was read. False
 *   for `March 1, 2026 09:00`, which `Date.parse` resolves as local time exactly
 *   as it resolves a naive ISO value — and those are the rows whose timezone was
 *   assigned most speculatively of all.
 *
 * Deciding it properly means reimplementing the set of spellings `Date.parse`
 * accepts, which is implementation-defined outside the ISO subset. So the report
 * states what it actually knows — the raw value and the instant it resolved to —
 * and says the zone question is undetermined. An honest "unknown" beats a
 * confident answer in either direction.
 */

/**
 * What one repair pass did, as a value.
 *
 * The repair builds this and returns it; the caller prints it *after* the
 * transaction commits. Emitting from inside the transaction would let a
 * rollback — a lost lock, `SQLITE_FULL`, a non-`RangeError` escaping
 * `normalizeDue` — leave stderr asserting that rows were rewritten when they
 * were reverted. A log that describes work which did not happen is worse than
 * no log, and this shape makes it unrepresentable.
 *
 * `sample` arrays are capped at `MAX_LOGGED_ROWS`; the paired `*Total` counts
 * every row, so a truncated sample never truncates a count.
 */
interface RepairReport {
  changed: number;
  candidates: number;
  before: Record<DueShape, number>;
  /** Read back from the DB after the writes, never derived from what we sent. */
  remaining: number;
  offsetsLeft: number;
  assumedLocal: string[];
  assumedLocalTotal: number;
  unrecognizedRows: string[];
  unrecognizedTotal: number;
  unparseable: string[];
  unparseableTotal: number;
}

function pushCapped(sample: string[], line: string): void {
  if (sample.length < MAX_LOGGED_ROWS) sample.push(line);
}

function emitCapped(sample: string[], total: number, suffix: string): void {
  for (const line of sample) console.error(line);
  if (total > sample.length) {
    console.error(`tickler-mcp: … and ${total - sample.length} more ${suffix}.`);
  }
}

/** Print a committed repair. All output is stderr — stdout carries JSON-RPC. */
function reportRepair(r: RepairReport): void {
  console.error(
    `tickler-mcp: due backfill — ${r.candidates} legacy row(s) ` +
      `(offset-suffixed ${r.before.offset}, non-canonical UTC ${r.before.utc}, ` +
      `naive ${r.before.naive}, unrecognized ${r.before.unrecognized}). ` +
      `Naive values carry no timezone and are read as LOCAL time.`
  );
  emitCapped(r.assumedLocal, r.assumedLocalTotal, "naive row(s) read as local time");
  emitCapped(r.unrecognizedRows, r.unrecognizedTotal, "row(s) in an unrecognized format");
  emitCapped(r.unparseable, r.unparseableTotal, "unparseable row(s) left as-is");
  console.error(
    `tickler-mcp: due backfill complete — ${r.changed} rewritten, ` +
      `${r.offsetsLeft} offset-suffixed remaining, ${r.remaining} non-canonical remaining.`
  );
  if (r.offsetsLeft > 0) {
    console.error(
      `tickler-mcp: MIGRATION INCOMPLETE — ${r.offsetsLeft} row(s) still carry a UTC offset ` +
        `and will compare incorrectly against a UTC-Z now (issue #6). See the unparseable ` +
        `rows logged above.`
    );
  }
}

/**
 * Rewrite any `due` still stored in a pre-normalization format (issue #3).
 * Exported for testing.
 *
 * Runs on every DB open rather than behind a `user_version` gate. Up to 16 MCP
 * processes share this file, and during a rollout an older binary can write a
 * legacy row *after* a one-time migration has already fired — a version gate
 * would never look again, while this check is self-healing.
 *
 * `NOT GLOB` is not sargable, so the probe is an O(N) scan that no index on
 * `due` can help. That is fine at this table's size (measured: 0.2 ms at 1k
 * rows, 19 ms at 100k) and it runs once per process, not per tool call — but
 * nothing here ever prunes done rows, so N only grows. If it ever shows up,
 * the fix is a partial index on the legacy predicate rather than a version gate:
 *
 *   CREATE INDEX idx_legacy ON ticklers(id) WHERE due NOT GLOB '<same literal>';
 *
 * which SQLite does use (19 ms → 0.0 ms at 100k) and which keeps the check
 * self-healing.
 *
 * Failures are logged and swallowed, including SQLite errors such as
 * SQLITE_BUSY — which the 16-process concurrency this function exists to survive
 * makes entirely reachable. A backfill that cannot run right now must not make
 * the store unopenable for every process; the next open tries again.
 *
 * ## Reporting (issue #6)
 *
 * The repair path builds a `RepairReport` and prints it *after* the transaction
 * commits: before/after counts by stored shape, plus every row that took the
 * naive → local-time fallback. A naive `due` carries no
 * recoverable timezone, so reading it as local is a *guess* — a defensible one,
 * made where the author's intent still existed, but a guess. An unattributable
 * guess is the failure mode this codebase names most often: an unknown value
 * resolving quietly to a default with no error anywhere. Counts alone cannot say
 * *which* row was guessed at, so the rows are named too, up to `MAX_LOGGED_ROWS`.
 *
 * The post-condition — zero offset-suffixed rows remaining — is **reported, not
 * enforced**. Deliberate, and the alternatives are worse:
 *
 * - *Throwing* would break this function's contract above: it runs inside
 *   `openDb()`, so an exception makes the store unopenable for that process.
 * - *Rolling back* would revert rows that were successfully repaired, returning
 *   them to the fire-early state this code exists to end — converting a partial
 *   success into a total failure with the same input waiting at the next open.
 *
 * A row can only survive the rewrite if `normalizeDue()` rejects it, i.e. it is
 * unparseable and no retry can fix it. So the useful action is to repair
 * everything repairable and make what is left *loud*, which is what this does.
 *
 * All output goes to stderr. The MCP server speaks JSON-RPC over stdout, and a
 * stray log line there corrupts the protocol.
 */
export function normalizeStoredDueDates(db: Database.Database): number {
  try {
    // Unlocked probe first. On a healthy DB this matches nothing and returns
    // without ever taking a write lock — worth keeping, since this runs on every
    // open in every process.
    const needsRepair = db
      .prepare(`SELECT 1 FROM ticklers WHERE ${LEGACY_DUE_WHERE} LIMIT 1`)
      .get();
    if (needsRepair === undefined) return 0;

    // Repair path. The candidate SELECT is re-run *inside* an immediate
    // transaction rather than reused from the probe: read outside the write
    // lock and a concurrent snoozeTickler can land between the read and the
    // UPDATE, after which this would overwrite the new due with a value derived
    // from a stale read — resurrecting a fire-early tickler, the exact bug this
    // code exists to prevent. Taking the lock up front also collapses the
    // upgrade herd, so one process repairs and the rest find nothing to do.
    const report = db.transaction(() => {
      const candidates = db
        .prepare(`SELECT id, due FROM ticklers WHERE ${LEGACY_DUE_WHERE}`)
        .all() as { id: string; due: string }[];

      // `AND due = @old` is a second guard on the same race, and is deliberately
      // unreachable as written: the IMMEDIATE transaction above already makes the
      // re-SELECT and this UPDATE atomic, so `due` cannot change in between and
      // no test can drive this predicate to zero rows. It is kept as insurance
      // against a future change that moves the SELECT back outside the lock —
      // the mistake this function shipped with once. Do not read it as covered.
      const update = db.prepare(
        "UPDATE ticklers SET due = @due WHERE id = @id AND due = @old"
      );

      const r: RepairReport = {
        changed: 0,
        candidates: candidates.length,
        before: { offset: 0, utc: 0, naive: 0, unrecognized: 0 },
        remaining: 0,
        offsetsLeft: 0,
        assumedLocal: [],
        assumedLocalTotal: 0,
        unrecognizedRows: [],
        unrecognizedTotal: 0,
        unparseable: [],
        unparseableTotal: 0,
      };

      for (const row of candidates) {
        const shape = classifyDue(row.due);
        r.before[shape] += 1;

        let normalized: string;
        try {
          normalized = normalizeDue(row.due);
        } catch (err) {
          // Narrowed, so a bug inside normalizeDue cannot masquerade as bad data.
          if (!(err instanceof RangeError)) throw err;
          r.unparseableTotal += 1;
          pushCapped(
            r.unparseable,
            `tickler-mcp: tickler ${row.id} has an unparseable due "${row.due}" — left as-is.`
          );
          continue;
        }

        // Named individually: this row's timezone was assumed, not read.
        if (shape === "naive") {
          r.assumedLocalTotal += 1;
          pushCapped(
            r.assumedLocal,
            `tickler-mcp: tickler ${row.id} due "${row.due}" has no timezone — ` +
              `assumed local, stored as ${normalized}.`
          );
        } else if (shape === "unrecognized") {
          // Stated as an open question, not as a fact in either direction — see
          // the note on `unrecognized` above.
          r.unrecognizedTotal += 1;
          pushCapped(
            r.unrecognizedRows,
            `tickler-mcp: tickler ${row.id} due "${row.due}" is not ISO 8601 — ` +
              `Date.parse read it as ${normalized}. Whether that spelling carried a ` +
              `timezone or was assumed local is not determined here; check it.`
          );
        }

        r.changed += update.run({ id: row.id, due: normalized, old: row.due }).changes;
      }

      // Post-condition read back from the DB rather than derived from the loop
      // above: a count computed from what we believe we wrote cannot detect that
      // a write did not land. "No errors" is not evidence a migration worked.
      const remaining = db
        .prepare(`SELECT due FROM ticklers WHERE ${LEGACY_DUE_WHERE}`)
        .all() as { due: string }[];
      r.remaining = remaining.length;
      for (const row of remaining) if (OFFSET_SUFFIX.test(row.due)) r.offsetsLeft += 1;

      return r;
    }).immediate();

    // Losing the repair race is a non-event, not a migration. Several processes
    // can clear the unlocked probe before the first one commits; each then takes
    // the lock in turn and finds the work already done. That is the herd
    // collapsing exactly as intended — but reporting it would print up to 15
    // "0 legacy row(s) … 0 rewritten" backfills for one real migration, which
    // reads as fifteen migrations that found nothing rather than one that
    // succeeded.
    if (report.candidates === 0) return 0;

    // Printed only once the transaction has committed. Inside it, any rollback
    // would leave stderr claiming rows were rewritten that were reverted.
    reportRepair(report);
    return report.changed;
  } catch (err) {
    console.error(`tickler-mcp: due-date backfill skipped — ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Migrate ticklers from a legacy JSON file into an open SQLite database.
 * Exported for testing.
 * - If the JSON file does not exist, returns immediately (no-op).
 * - If the JSON is corrupted, logs a warning and returns (file left intact).
 * - On success, renames the JSON file to .migrated.
 */
export function runMigration(dbOrPath: Database.Database | string, jsonPath: string): void {
  if (!fs.existsSync(jsonPath)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch {
    return; // Can't read — skip, leave file intact
  }

  let parsed: { ticklers?: Tickler[] };
  try {
    parsed = JSON.parse(raw) as { ticklers?: Tickler[] };
  } catch {
    console.error(
      `tickler-mcp: ${jsonPath} is not valid JSON — skipping migration. Fix or delete it manually.`
    );
    return; // Corrupted — leave file intact for manual recovery
  }

  const db: Database.Database =
    typeof dbOrPath === "string" ? openDb(dbOrPath) : dbOrPath;
  // `openDb` already runs the schema/column guards for the string-path branch above. The
  // already-open-handle branch must run them too, defensively — a caller (this repo's own
  // sibling issue #10 migration, or any future one) may hand `runMigration` a
  // `Database.Database` that was never opened through `openDb`, and the INSERT below fails on
  // a genuinely old schema without this (codex round-4 code review, issue #9). All guards are
  // idempotent.
  db.exec(TICKLERS_SCHEMA_SQL);
  ensureRecurColumn(db);
  ensureNagColumns(db);
  ensureNotifyColumn(db);

  const ticklers = Array.isArray(parsed.ticklers) ? parsed.ticklers : [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ticklers (id, title, body, due, creator, notify, tags, status, created_at, completed_at, snoozed_until, recur, nag_every, nag_max, last_fired_at, nag_fire_count)
    VALUES (@id, @title, @body, @due, @creator, @notify, @tags, @status, @created_at, @completed_at, @snoozed_until, @recur, @nag_every, @nag_max, @last_fired_at, @nag_fire_count)
  `);

  const migrate = db.transaction((rows: Tickler[]) => {
    let skipped = 0;
    for (const t of rows) {
      // An unparseable due in legacy JSON must not abort the whole import — but
      // it must not be swallowed either. Skip the row, count it, and let the
      // caller decline the rename so the source file stays recoverable.
      let due: string;
      try {
        due = normalizeDue(t.due);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        skipped++;
        console.error(
          `tickler-mcp: skipping tickler ${t.id ?? "(no id)"} from ${jsonPath} — ${err.message}`
        );
        continue;
      }

      insert.run({
        id: t.id,
        title: t.title,
        body: t.body ?? null,
        due,
        creator: t.creator ?? null,
        // Legacy JSON predates notify (tickler-mcp#11) — default it the same way the nag
        // fields above are defaulted, rather than assuming the field is present.
        notify: t.notify ?? "agent",
        tags: JSON.stringify(Array.isArray(t.tags) ? t.tags : []),
        status: t.status ?? "pending",
        created_at: t.createdAt ?? new Date().toISOString(),
        completed_at: t.completedAt ?? null,
        snoozed_until: null,
        recur: t.recur ? JSON.stringify(t.recur) : null,
        // Legacy JSON predates nag (issue #10) — a row from that era never has it,
        // but a future-format import might, so read it defensively rather than
        // assuming null.
        nag_every: t.nag?.every ?? null,
        nag_max: t.nag?.max ?? null,
        last_fired_at: t.lastFiredAt ?? null,
        nag_fire_count: t.nagFireCount ?? 0,
      });
    }
    return skipped;
  });

  const skipped = migrate(ticklers);

  // A skipped row means the JSON holds data the DB does not. Renaming it here
  // would destroy the only copy. Bail out before the count check below — that
  // check counts every row in the table rather than the ones just imported, so
  // on a non-empty DB it would happily wave a lossy migration through.
  if (skipped > 0) {
    console.error(
      `tickler-mcp: ${skipped} tickler(s) in ${jsonPath} had an unparseable due date and were ` +
        `not imported. Leaving the file in place for manual recovery — it will NOT be renamed.`
    );
    return;
  }

  // Verify all rows made it in before renaming
  const dbCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM ticklers").get() as { cnt: number }
  ).cnt;

  if (dbCount >= ticklers.length) {
    try {
      fs.renameSync(jsonPath, jsonPath + ".migrated");
    } catch {
      // Rename failed — not fatal, data is in DB
    }
  }
}

function rowToTickler(row: Record<string, unknown>): Tickler {
  return {
    id: row.id as string,
    title: row.title as string,
    body: (row.body as string) ?? "",
    due: row.due as string,
    creator: (row.creator as string) ?? "unknown",
    notify: ((row.notify as string) ?? "agent") as NotifyChannel,
    tags: row.tags ? (JSON.parse(row.tags as string) as string[]) : [],
    status: row.status as "pending" | "done",
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    recur: row.recur ? (JSON.parse(row.recur as string) as Recur) : null,
    nag: row.nag_every
      ? { every: row.nag_every as string, max: (row.nag_max as number | null) ?? undefined }
      : null,
    lastFiredAt: (row.last_fired_at as string | null) ?? null,
    nagFireCount: (row.nag_fire_count as number | null) ?? 0,
  };
}

export function createTickler(tickler: Tickler): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ticklers (id, title, body, due, creator, notify, tags, status, created_at, completed_at, snoozed_until, recur, nag_every, nag_max, last_fired_at, nag_fire_count)
    VALUES (@id, @title, @body, @due, @creator, @notify, @tags, @status, @created_at, @completed_at, @snoozed_until, @recur, @nag_every, @nag_max, @last_fired_at, @nag_fire_count)
  `).run({
    id: tickler.id,
    title: tickler.title,
    body: tickler.body ?? null,
    due: normalizeDue(tickler.due),
    creator: tickler.creator ?? null,
    notify: tickler.notify ?? "agent",
    tags: JSON.stringify(tickler.tags ?? []),
    status: tickler.status,
    created_at: tickler.createdAt,
    completed_at: tickler.completedAt ?? null,
    snoozed_until: null,
    recur: tickler.recur ? JSON.stringify(tickler.recur) : null,
    nag_every: tickler.nag?.every ?? null,
    nag_max: tickler.nag?.max ?? null,
    last_fired_at: tickler.lastFiredAt ?? null,
    nag_fire_count: tickler.nagFireCount ?? 0,
  });
}

export function listTicklers(opts?: { status?: "pending" | "done"; tag?: string }): Tickler[] {
  const db = getDb();
  let sql = "SELECT * FROM ticklers";
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (opts?.status) {
    conditions.push("status = @status");
    params.status = opts.status;
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY due ASC";

  const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  let ticklers = rows.map(rowToTickler);

  if (opts?.tag) {
    ticklers = ticklers.filter((t) => t.tags.includes(opts.tag!));
  }

  return ticklers;
}

/**
 * Attempt to atomically claim a nag fire for `candidate`, using its own previously-read
 * `lastFiredAt` as the CAS comparison (same shape as `completeTickler`'s `AND status =
 * 'pending'` and `normalizeStoredDueDates`'s `AND due = @old`). Exported so tests can drive
 * it directly against a deliberately STALE snapshot — `checkTicklers`'s own base query
 * already excludes a row that changed before it ran, so a race that happens strictly
 * *between* reading a candidate and claiming it can only be exercised by calling this
 * helper with a snapshot read before some other mutation landed (issue #10, codex plan
 * review rounds 2-3).
 *
 * Returns the updated `Tickler` (with `lastFiredAt`/`nagFireCount` reflecting the claim) on
 * success, or `null` if the live row no longer matches `candidate`'s assumptions — already
 * completed, no longer due (e.g. snoozed into the future since `candidate` was read),
 * already exhausted, or already fired by a concurrent claim.
 */
export function claimNagFire(candidate: Tickler, now: string): Tickler | null {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE ticklers
       SET last_fired_at = @now, nag_fire_count = nag_fire_count + 1
       WHERE id = @id
         AND status = 'pending'
         AND due <= @now
         AND (nag_max IS NULL OR nag_fire_count < nag_max)
         AND ((last_fired_at IS NULL AND @oldLastFiredAt IS NULL) OR last_fired_at = @oldLastFiredAt)`
    )
    .run({ id: candidate.id, now, oldLastFiredAt: candidate.lastFiredAt });
  if (result.changes === 0) return null;
  return { ...candidate, lastFiredAt: now, nagFireCount: candidate.nagFireCount + 1 };
}

/**
 * Nag-eligibility check for a candidate already known to be pending and due (issue #10).
 * Non-nag ticklers are always eligible (unchanged behavior). A nag ticklers is eligible if
 * it has never fired, or `every` has elapsed since its last fire — already-exhausted rows
 * are filtered out in SQL before this runs (see `checkTicklers`), so this never needs to
 * check `max` itself.
 */
function isNagEligible(t: Tickler, now: string): boolean {
  if (!t.nag) return true;
  if (t.lastFiredAt === null) return true;
  const everyMs = parseDuration(t.nag.every);
  // Validated at create time; a null here would mean corrupt data — treat as
  // always-eligible rather than throwing mid-scan.
  if (everyMs === null) return true;
  const elapsed = Date.parse(now) - Date.parse(t.lastFiredAt);
  return elapsed >= everyMs;
}

/**
 * Eligibility for the telegram notify-due path (tickler-mcp#11). Different from
 * `isNagEligible`: a non-nag telegram tickler must fire EXACTLY ONCE (never again once
 * `lastFiredAt` is set), because nothing re-polls it into an agent's attention the way a
 * session-based `tickler_check` does. A nag telegram tickler re-fires per its own
 * `nag.every`/`max`, same rule as `isNagEligible`.
 */
function isNotifyEligible(t: Tickler, now: string): boolean {
  if (t.lastFiredAt === null) return true;
  if (!t.nag) return false;
  const everyMs = parseDuration(t.nag.every);
  if (everyMs === null) return false;
  const elapsed = Date.parse(now) - Date.parse(t.lastFiredAt);
  return elapsed >= everyMs;
}

/**
 * Read the due `telegram:dave` ticklers for the Telegram poller (tickler-mcp#11) — a pure
 * read. Same base filter shape as `checkTicklers` (pending / due / not nag-exhausted) with
 * the channel flipped, plus the `isNotifyEligible` gate applied JS-side the same way
 * `checkTicklers` applies `isNagEligible`.
 *
 * Deliberately does NOT claim anything (`claimNagFire` is never called here): the poller
 * sends first and marks fired only after the send is confirmed, via `claimNotifyFire`. A read
 * that marked rows fired would lose a tickler to every failed send — the exact failure this
 * two-step exists to make impossible. `lastFiredAt` is handed back to the caller as the CAS
 * token for that claim.
 */
export function checkNotifyDue(now: string = new Date().toISOString()): Tickler[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM ticklers
       WHERE status = 'pending' AND due <= @now AND notify = 'telegram:dave'
         AND (nag_every IS NULL OR nag_max IS NULL OR nag_fire_count < nag_max)
       ORDER BY due ASC`
    )
    .all({ now }) as Record<string, unknown>[];
  const candidates = rows.map(rowToTickler);
  return candidates.filter((t) => isNotifyEligible(t, now));
}

/**
 * Claim a notify-due fire for `id`, using `prevLastFiredAt` (the `lastFiredAt` value the
 * caller read via `checkNotifyDue`, as its own CAS token) as the compare-and-swap
 * comparison — same mechanism as `claimNagFire`. Returns true if claimed (the tickler is
 * now marked fired), false if the live row no longer matches (already fired by a
 * concurrent run, completed, snoozed into the future, or exhausted) — the caller should
 * treat false as "leave it, it will be retried or was already handled."
 *
 * Reads the live row fresh (rather than trusting a caller-supplied full Tickler) because
 * this is called from a separate process/invocation (tickler-mcp#11's `notify-mark-fired`
 * CLI command) that only carries the id + token forward, not the full row.
 */
export function claimNotifyFire(id: string, prevLastFiredAt: string | null, now: string): boolean {
  const existing = getTickler(id);
  if (!existing) return false;
  const claimed = claimNagFire({ ...existing, lastFiredAt: prevLastFiredAt }, now);
  return claimed !== null;
}

/**
 * Return past-due pending ticklers. By default (`markFired: true`) a due nag tickler's fire
 * is claimed atomically — `lastFiredAt`/`nagFireCount` advance and it will not be returned
 * again until `every` elapses (or ever again, once `max` fires are reached — issue #10).
 * Pass `markFired: false` for a dry read (what `tickler_list` structurally already gets, and
 * what `tickler_check --no-mark-fired` / `mark_fired:false` opts into explicitly) that never
 * advances the nag clock.
 *
 * Agent-delivered only: the WHERE matches `notify = 'agent'` positively (tickler-mcp#11), so
 * a `telegram:dave` tickler is invisible here and a future third channel cannot leak into an
 * agent's attention by mere omission. The telegram path is `checkNotifyDue`.
 */
export function checkTicklers(markFired: boolean = true): Tickler[] {
  const db = getDb();
  const now = new Date().toISOString();
  // Already-exhausted nag rows are excluded here in SQL, not materialized and discarded in
  // JS, so a long tail of acknowledged-but-never-completed nag ticklers doesn't grow this
  // scan (codex plan-review round 1 COST finding).
  const rows = db
    .prepare(
      `SELECT * FROM ticklers
       WHERE status = 'pending' AND due <= @now AND notify = 'agent'
         AND (nag_every IS NULL OR nag_max IS NULL OR nag_fire_count < nag_max)
       ORDER BY due ASC`
    )
    .all({ now }) as Record<string, unknown>[];
  const candidates = rows.map(rowToTickler);

  const due: Tickler[] = [];
  for (const t of candidates) {
    if (!isNagEligible(t, now)) continue;
    if (!t.nag) {
      due.push(t);
      continue;
    }
    if (!markFired) {
      due.push(t);
      continue;
    }
    const claimed = claimNagFire(t, now);
    // claimNagFire returning null here means the row changed since this SELECT read it
    // (another process claimed it, snoozed it, or it became exhausted) — skip it this cycle
    // rather than returning stale data.
    if (claimed) due.push(claimed);
  }
  return due;
}

export interface CompleteResult {
  completed: boolean;
  /** Present only when the completed tickler was recurring and a successor was created. */
  nextId?: string;
  nextDue?: string;
}

/**
 * Mark a tickler done. If it was recurring, atomically create the next pending occurrence
 * (never in the past, skipping any missed slots) and return its id.
 *
 * The completion UPDATE is guarded with `AND status = 'pending'` and its `changes` count is
 * what decides whether a successor gets created — so completing an already-done tickler
 * twice (a race, a retry) is a no-op the second time, never a duplicate successor. Both the
 * completion and the successor insert run inside one `db.transaction()`, so a crash between
 * them can never leave a completed series with no next occurrence.
 */
export function completeTickler(id: string): CompleteResult {
  const db = getDb();

  const run = db.transaction((): CompleteResult => {
    const existing = getTickler(id);
    if (!existing) return { completed: false };

    const now = new Date().toISOString();
    const result = db
      .prepare("UPDATE ticklers SET status = 'done', completed_at = @now WHERE id = @id AND status = 'pending'")
      .run({ id, now });
    if (result.changes === 0) return { completed: false };

    if (!existing.recur) return { completed: true };

    const nextDue = nextFutureOccurrence(existing.recur, existing.due, now);
    const next: Tickler = {
      id: crypto.randomUUID(),
      title: existing.title,
      body: existing.body,
      due: nextDue,
      tags: existing.tags,
      creator: existing.creator,
      // The delivery channel persists to the successor, same as the nag rule below —
      // a recurring telegram reminder does not fall back to agent delivery mid-series.
      notify: existing.notify,
      status: "pending",
      createdAt: now,
      completedAt: null,
      recur: existing.recur,
      // The nag RULE persists to the successor, but it starts its own fresh cycle —
      // never inherits the prior occurrence's fire history (issue #10).
      nag: existing.nag,
      lastFiredAt: null,
      nagFireCount: 0,
    };
    createTickler(next);
    return { completed: true, nextId: next.id, nextDue: next.due };
  });

  return run();
}

export function deleteTickler(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM ticklers WHERE id = @id").run({ id });
  return result.changes > 0;
}

export function snoozeTickler(id: string, newDue: string): boolean {
  const db = getDb();
  // Normalize here too, not just in createTickler: a snooze writes `due` exactly
  // as a create does, and fixing only create leaves the same bug reachable by a
  // different door while looking identical from the outside.
  const due = normalizeDue(newDue);
  // Re-open a completed tickler if it is being snoozed. `last_fired_at` is reset to NULL
  // unconditionally (harmless for non-nag rows, where it's already unused) so a nag
  // tickler's cadence "pauses" while `due` is in the future — the base due<=now filter in
  // `checkTicklers` already excludes it — and "resumes" exactly at the new `due`: with
  // `lastFiredAt` null, the next check treats it as a fresh first fire rather than waiting
  // out the interval from before the snooze (issue #10, codex plan-review round 1).
  // `nag_fire_count` is left untouched — snoozing must not reset the `max` exhaustion budget.
  const result = db.prepare(
    "UPDATE ticklers SET due = @due, status = 'pending', completed_at = NULL, last_fired_at = NULL WHERE id = @id"
  ).run({ id, due });
  return result.changes > 0;
}

export function getTickler(id: string): Tickler | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM ticklers WHERE id = @id")
    .get({ id }) as Record<string, unknown> | undefined;
  return row ? rowToTickler(row) : undefined;
}

// Format a tickler for display. Uses system local time if no tz provided.
export function formatTickler(t: Tickler, tz?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  if (tz) opts.timeZone = tz;

  const dueStr = new Date(t.due).toLocaleString("en-US", opts);
  const tagsStr = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
  const completedStr = t.completedAt
    ? `\n  Completed: ${new Date(t.completedAt).toLocaleString("en-US", tz ? { timeZone: tz } : {})}`
    : "";
  // formatRecur reads the series' own fixed anchor internally, never this occurrence's
  // (possibly snoozed) `due` — otherwise snoozing Sunday 07:00 to 08:00 would display
  // "↻ weekly SU 08:00 ..." even though every later occurrence still fires at 07:00 (codex
  // round-3 code review). Also not the `tz` display override above — "07:00 stays 07:00" is
  // about the rule's own timezone, not the viewer's.
  const recurStr = t.recur ? `\n  Recur: ↻ ${formatRecur(t.recur)}` : "";
  const nagStr = t.nag ? `\n  Nag: ${formatNag(t.nag, t.lastFiredAt, t.nagFireCount, tz)}` : "";
  return `[${t.status.toUpperCase()}] ${t.title}${tagsStr}\n  ID: ${t.id}\n  Due: ${dueStr}\n  Body: ${t.body}\n  Creator: ${t.creator}${completedStr}${recurStr}${nagStr}`;
}

/**
 * Render a nag rule's live state, e.g. `⟳ every 1d (fired 3×, last Sep 15, 2026, 2:00 PM)`,
 * appending `, nag-exhausted` once `max` fires have been used (issue #10). Exhaustion is
 * derived here from `nagFireCount` vs `nag.max` rather than a stored boolean, so there is no
 * second source of truth that could drift from the count.
 */
function formatNag(nag: Nag, lastFiredAt: string | null, nagFireCount: number, tz?: string): string {
  const maxStr = nag.max !== undefined ? ` (max ${nag.max})` : "";
  const lastStr = lastFiredAt
    ? `, last ${new Date(lastFiredAt).toLocaleString("en-US", tz ? { timeZone: tz } : {})}`
    : "";
  const exhausted = nag.max !== undefined && nagFireCount >= nag.max;
  const exhaustedStr = exhausted ? ", nag-exhausted" : "";
  return `⟳ every ${nag.every}${maxStr} (fired ${nagFireCount}×${lastStr}${exhaustedStr})`;
}
