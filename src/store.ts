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

  return db;
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

  const migrate = db.transaction((rows: Tickler[]) => {
    for (const t of rows) {
      insert.run({
        id: t.id,
        title: t.title,
        body: t.body ?? null,
        due: t.due,
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
    due: tickler.due,
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
  // Re-open a completed tickler if it is being snoozed
  const result = db.prepare(
    "UPDATE ticklers SET due = @due, status = 'pending', completed_at = NULL WHERE id = @id"
  ).run({ id, due: newDue });
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
