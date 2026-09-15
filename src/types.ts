export type { Recur, Weekday } from "./recur.js";
import type { Recur } from "./recur.js";

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
}

export interface TicklerStore {
  ticklers: Tickler[];
}
