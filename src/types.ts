export type { Recur, Weekday } from "./recur.js";
import type { Recur } from "./recur.js";

/**
 * A re-fire rule: once a tickler is due, `tickler_check` keeps returning it
 * every `every` until `tickler_complete` or `max` fires are reached (issue #10).
 */
export interface Nag {
  every: string; // duration string, e.g. "1d", "4h" — validated via parseDuration
  max?: number; // total fires before exhaustion; omitted = unlimited
}

export interface Tickler {
  id: string;
  title: string;
  body: string;
  due: string; // ISO 8601
  tags: string[];
  creator: string;
  status: "pending" | "done";
  createdAt: string;
  completedAt: string | null;
  recur: Recur | null;
  nag: Nag | null;
  lastFiredAt: string | null; // ISO, null until first nag fire (reset by snooze)
  nagFireCount: number; // 0 default, incremented on each markFired=true fire
}

export interface TicklerStore {
  ticklers: Tickler[];
}
