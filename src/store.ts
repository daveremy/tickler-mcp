import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Tickler } from "./types.js";

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

/** `YYYY-MM-DD` with no time part. Tested before `Date.parse` — see `normalizeDue`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Canonicalize a due timestamp to UTC-Z (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
 *
 * Every write path funnels through here so the `due` TEXT column ever holds only
 * one spelling of an instant. `checkTicklers` compares `due` against
 * `new Date().toISOString()` using SQLite's lexicographic `<=`, which is a valid
 * instant comparison only when both sides share a frame of reference. Storing
 * input verbatim let a `-07:00` timestamp sort as though it were UTC, firing
 * reminders up to a full offset early — always early, never late, which is why
 * it read as working software for so long (issue #3).
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
 * @throws {RangeError} when `due` cannot be parsed. Failing loudly at write time
 * beats storing a string that mis-sorts silently forever.
 */
export function normalizeDue(due: string): string {
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

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
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
      snoozed_until TEXT
    )
  `);

  normalizeStoredDueDates(db);

  return db;
}

/**
 * Canonical UTC-Z shape, exactly as `toISOString()` emits it. GLOB rather than
 * LIKE because GLOB is case-sensitive and can assert digits — LIKE would treat a
 * trailing lowercase `z` as already-canonical and skip a row that needs fixing.
 */
const CANONICAL_DUE_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

/**
 * Rewrite any `due` still stored in a pre-normalization format (issue #3).
 * Returns the number of rows changed. Exported for testing.
 *
 * Runs on every DB open rather than behind a `user_version` gate. Up to 16 MCP
 * processes share this file, and during a rollout an older binary can write a
 * legacy row *after* a one-time migration has already fired — a version gate
 * would never look again, while this check is self-healing. It stays cheap: the
 * GLOB prefilter matches every healthy row, so the normal case is one scan of a
 * small table that writes nothing.
 *
 * Never throws. A single malformed row must not make the store unopenable for
 * every process on the box; unparseable rows are logged and left untouched.
 */
export function normalizeStoredDueDates(db: Database.Database): number {
  const candidates = db
    .prepare(`SELECT id, due FROM ticklers WHERE due NOT GLOB '${CANONICAL_DUE_GLOB}'`)
    .all() as { id: string; due: string }[];

  if (candidates.length === 0) return 0;

  const update = db.prepare("UPDATE ticklers SET due = @due WHERE id = @id");
  let changed = 0;

  db.transaction(() => {
    for (const row of candidates) {
      let normalized: string;
      try {
        normalized = normalizeDue(row.due);
      } catch {
        console.error(
          `tickler-mcp: tickler ${row.id} has an unparseable due "${row.due}" — left as-is.`
        );
        continue;
      }
      if (normalized !== row.due) {
        update.run({ id: row.id, due: normalized });
        changed++;
      }
    }
  })();

  return changed;
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

  const ticklers = Array.isArray(parsed.ticklers) ? parsed.ticklers : [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ticklers (id, title, body, due, creator, tags, status, created_at, completed_at, snoozed_until)
    VALUES (@id, @title, @body, @due, @creator, @tags, @status, @created_at, @completed_at, @snoozed_until)
  `);

  let skipped = 0;

  const migrate = db.transaction((rows: Tickler[]) => {
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
        tags: JSON.stringify(Array.isArray(t.tags) ? t.tags : []),
        status: t.status ?? "pending",
        created_at: t.createdAt ?? new Date().toISOString(),
        completed_at: t.completedAt ?? null,
        snoozed_until: null,
      });
    }
  });

  migrate(ticklers);

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
    tags: row.tags ? (JSON.parse(row.tags as string) as string[]) : [],
    status: row.status as "pending" | "done",
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export function createTickler(tickler: Tickler): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ticklers (id, title, body, due, creator, tags, status, created_at, completed_at, snoozed_until)
    VALUES (@id, @title, @body, @due, @creator, @tags, @status, @created_at, @completed_at, @snoozed_until)
  `).run({
    id: tickler.id,
    title: tickler.title,
    body: tickler.body ?? null,
    due: normalizeDue(tickler.due),
    creator: tickler.creator ?? null,
    tags: JSON.stringify(tickler.tags ?? []),
    status: tickler.status,
    created_at: tickler.createdAt,
    completed_at: tickler.completedAt ?? null,
    snoozed_until: null,
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

export function checkTicklers(): Tickler[] {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(
    "SELECT * FROM ticklers WHERE status = 'pending' AND due <= @now ORDER BY due ASC"
  ).all({ now }) as Record<string, unknown>[];
  return rows.map(rowToTickler);
}

export function completeTickler(id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE ticklers SET status = 'done', completed_at = @now WHERE id = @id"
  ).run({ id, now });
  return result.changes > 0;
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
  // Re-open a completed tickler if it is being snoozed
  const result = db.prepare(
    "UPDATE ticklers SET due = @due, status = 'pending', completed_at = NULL WHERE id = @id"
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
  return `[${t.status.toUpperCase()}] ${t.title}${tagsStr}\n  ID: ${t.id}\n  Due: ${dueStr}\n  Body: ${t.body}\n  Creator: ${t.creator}${completedStr}`;
}
