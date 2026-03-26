import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Tickler, TicklerStore } from "./types.js";

// Storage path: TICKLER_PATH env var overrides the default
export const STORAGE_PATH =
  process.env.TICKLER_PATH ??
  path.join(os.homedir(), ".tickler", "ticklers.json");

const LOCK_PATH = STORAGE_PATH + ".lock";

function ensureDir(): void {
  const dir = path.dirname(STORAGE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readStore(): TicklerStore {
  ensureDir();
  if (!fs.existsSync(STORAGE_PATH)) {
    return { ticklers: [] };
  }
  const raw = fs.readFileSync(STORAGE_PATH, "utf-8");
  try {
    return JSON.parse(raw) as TicklerStore;
  } catch {
    throw new Error(`Tickler store is corrupted at ${STORAGE_PATH}. Fix the JSON or delete the file to start fresh.`);
  }
}

// Atomic write: write to temp, then rename
export function writeStore(store: TicklerStore): void {
  ensureDir();
  const tmp = STORAGE_PATH + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, STORAGE_PATH);
}

function acquireLock(): boolean {
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // ignore
  }
}

const LOCK_STALE_MS = 10_000; // Remove locks older than 10 seconds

function clearStaleLock(): void {
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    // Lock file doesn't exist — nothing to do
  }
}

// Lock-protected read-modify-write. Retries for up to 2 seconds.
// Uses Atomics.wait on a shared buffer for the wait — avoids spinning the event loop.
export function withLock<T>(fn: () => T): T {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let attempts = 0;
  clearStaleLock();
  while (!acquireLock()) {
    attempts++;
    if (attempts > 20) {
      throw new Error("Could not acquire file lock after 2 seconds");
    }
    // Yield for 100ms without burning CPU
    Atomics.wait(wait, 0, 0, 100);
  }
  try {
    return fn();
  } finally {
    releaseLock();
  }
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
