/**
 * Recurring-tickler rule and timezone-aware occurrence math.
 *
 * Kept deliberately small and typed rather than an RRULE string — nothing here needs the
 * RFC 5545 surface, and a typed shape is what an MCP client can validate (issue #9). No new
 * runtime dependency: every timezone conversion goes through `Intl.DateTimeFormat`, which
 * ships with Node.
 */

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface Recur {
  freq: "daily" | "weekly" | "monthly";
  interval?: number;
  byWeekday?: Weekday[];
  byMonthDay?: number;
  tz: string;
  /**
   * ISO UTC instant of the series' very first occurrence, set once by `resolveRecurForCreate`
   * and never modified afterward (including by `tickler_snooze`, which only ever touches a
   * single occurrence's `due`, never its `recur`). This is the fixed, immutable reference
   * `nextOccurrence` and `formatRecur` use for interval-alignment, implicit weekday/day-of-
   * month defaults, and the canonical time-of-day — so snoozing one occurrence to a different
   * date/time can never leak into the schedule of later occurrences (codex round-2/round-3
   * code review, issue #9). Optional ONLY on the way in — the raw shape an MCP client submits
   * to `tickler_create`, before `resolveRecurForCreate` has run and derived it. Every stored
   * `recur` has one; `nextOccurrence` and `formatRecur` both throw a clear `RangeError` rather
   * than silently falling back to a possibly-snoozed instant if it is somehow missing (design
   * review, issue #9 round 4 — a silent fallback here is what reintroduced the anchor bugs
   * three rounds in a row). Callers should never set this directly; it is server-derived.
   */
  anchor?: string;
}

const WEEKDAY_CODES: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY_INDEX: Record<Weekday, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Validate a `Recur` object. Throws `RangeError` on the first problem found — the same
 * fail-loudly-at-write-time convention as `normalizeDue` in store.ts.
 */
export function validateRecur(recur: Recur): void {
  if (recur.freq !== "daily" && recur.freq !== "weekly" && recur.freq !== "monthly") {
    throw new RangeError(`Invalid recur.freq ${JSON.stringify(recur.freq)}.`);
  }
  if (recur.interval !== undefined) {
    if (!Number.isInteger(recur.interval) || recur.interval < 1) {
      throw new RangeError(`Invalid recur.interval ${JSON.stringify(recur.interval)} — must be an integer >= 1.`);
    }
  }
  if (recur.byWeekday !== undefined) {
    if (recur.byWeekday.length === 0) {
      throw new RangeError("recur.byWeekday, if given, must not be empty.");
    }
    for (const day of recur.byWeekday) {
      if (!WEEKDAY_CODES.includes(day)) {
        throw new RangeError(`Invalid recur.byWeekday entry ${JSON.stringify(day)}.`);
      }
    }
  }
  if (recur.byMonthDay !== undefined) {
    if (!Number.isInteger(recur.byMonthDay) || recur.byMonthDay < 1 || recur.byMonthDay > 31) {
      throw new RangeError(`Invalid recur.byMonthDay ${JSON.stringify(recur.byMonthDay)} — must be an integer 1-31.`);
    }
  }
  if (typeof recur.tz !== "string" || recur.tz.trim() === "") {
    throw new RangeError("recur.tz is required.");
  }
  try {
    // Intl throws RangeError on an unrecognized IANA zone name.
    new Intl.DateTimeFormat("en-US", { timeZone: recur.tz });
  } catch {
    throw new RangeError(`Invalid recur.tz ${JSON.stringify(recur.tz)} — not a recognized IANA timezone.`);
  }
}

/** Format a UTC instant's wall-clock components in `tz`. */
export function getWallTime(utcIso: string, tz: string): WallTime {
  const date = new Date(utcIso);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };
  let hour = get("hour");
  // hour12:false can render midnight as "24" in some ICU builds — normalize to 0.
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

function wallToUtcMillisLiteral(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * Offset (in ms, such that `wallAsUtcMs = instantMs + offset`) in effect at `instantMs` in `tz`.
 */
function offsetAtInstant(instantMs: number, tz: string): number {
  const wall = getWallTime(new Date(instantMs).toISOString(), tz);
  return wallToUtcMillisLiteral(wall) - instantMs;
}

/**
 * Convert wall-clock components meant to represent local time in `tz` into a UTC ISO string.
 *
 * Standard 2-3 pass convergence: guess the instant by treating the wall components as if they
 * were UTC, read the real offset in effect near that guess, correct, and repeat until the
 * offset stops changing. This converges in 1-2 passes for any ordinary wall time, because the
 * offset function is piecewise-constant except across a DST transition.
 *
 * It does NOT implement a designed policy for a genuinely nonexistent (spring-forward gap) or
 * genuinely ambiguous (fall-back overlap) wall time — past the iteration cap the loop simply
 * returns its last candidate (deterministic given the algorithm, but not a chosen policy for
 * that edge case). This is not exercised by any of this issue's acceptance criteria and was
 * reviewed and accepted at the plan stage; note (design review, issue #9 round 4) that most
 * US/EU zones transition in the small hours, but not all IANA zones do — America/Santiago,
 * America/Havana, and Asia/Beirut transition at or near midnight, so an ordinary-looking daily
 * due time like 00:30 can land inside the gap/overlap window there. If gap/overlap handling
 * ever needs to be a designed policy
 * (e.g. "gap snaps forward past the transition; overlap picks the earlier instant") belongs
 * here as a deliberate addition, not folded silently into this convergence loop.
 */
export function wallTimeToUtcIso(wall: WallTime, tz: string): string {
  const target = wallToUtcMillisLiteral(wall);
  let offset = offsetAtInstant(target, tz);
  let candidate = target - offset;
  for (let i = 0; i < 3; i++) {
    const newOffset = offsetAtInstant(candidate, tz);
    if (newOffset === offset) break;
    offset = newOffset;
    candidate = target - offset;
  }
  return new Date(candidate).toISOString();
}

function calDateToUtcMs(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function addCalDays(wall: WallTime, days: number): WallTime {
  const ms = calDateToUtcMs(wall.year, wall.month, wall.day) + days * 86400000;
  const d = new Date(ms);
  return {
    ...wall,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function calWeekday(wall: WallTime): number {
  return new Date(calDateToUtcMs(wall.year, wall.month, wall.day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the *next* month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Is `wall` a date that satisfies `recur`'s day-selection rule (ignoring `interval`)?
 * `interval` alignment is checked separately by callers that need it (`nextOccurrence`);
 * this function only asks "is this the right day of the week / month".
 */
export function isValidOccurrence(recur: Recur, wall: WallTime): boolean {
  if (recur.freq === "daily") return true;
  if (recur.freq === "weekly") {
    const days = recur.byWeekday?.length ? recur.byWeekday.map((w) => WEEKDAY_INDEX[w]) : [calWeekday(wall)];
    return days.includes(calWeekday(wall));
  }
  // monthly
  const target = recur.byMonthDay ?? wall.day;
  const clamped = Math.min(target, daysInMonth(wall.year, wall.month));
  return wall.day === clamped;
}

/**
 * Find the earliest due (>= the given due) that satisfies `recur`. If `due` already matches,
 * returns it unchanged (`snapped: false`) — never recomputed, so the exact original timestamp
 * is preserved. Otherwise walks forward day-by-day (bounded at 400 days) keeping the same
 * time-of-day until it finds a match.
 */
export function firstOccurrence(recur: Recur, dueUtcIso: string): { due: string; snapped: boolean } {
  const wall = getWallTime(dueUtcIso, recur.tz);
  if (isValidOccurrence(recur, wall)) {
    return { due: dueUtcIso, snapped: false };
  }
  let candidate = wall;
  for (let i = 0; i < 400; i++) {
    candidate = addCalDays(candidate, 1);
    if (isValidOccurrence(recur, candidate)) {
      return { due: wallTimeToUtcIso(candidate, recur.tz), snapped: true };
    }
  }
  throw new RangeError(`Could not find a valid first occurrence for recur ${JSON.stringify(recur)} near ${dueUtcIso}.`);
}

/**
 * Validate `recur`, resolve the first occurrence (snapping forward if `due` doesn't already
 * match), and persist two things onto the returned `recur` that must never be silently
 * re-derived later:
 *
 * 1. For monthly rules where the caller omitted `byMonthDay` — the day-of-month, from that
 *    first occurrence. `nextOccurrence`'s monthly branch always reads `recur.byMonthDay`
 *    verbatim rather than re-deriving a default from "whatever day the previous occurrence
 *    landed on". Without persisting an explicit day here, an omitted `byMonthDay` would
 *    silently drift after any clamped short month (Jan 31 -> Feb 28 -> Mar 28, instead of back
 *    to 31).
 * 2. `anchor` (if not already set) — the resolved first occurrence itself. `nextOccurrence`
 *    uses this as the fixed reference for weekly `interval`-week alignment and for the
 *    series' canonical time-of-day, so a later `tickler_snooze` on any one occurrence's `due`
 *    can never shift the schedule of the occurrences that follow it.
 *
 * The `recur` object this function returns is what must be stored, not the caller's original.
 * Shared by `mcp.ts` and `cli.ts` so this isn't duplicated in both call sites.
 */
export function resolveRecurForCreate(
  recur: Recur,
  dueUtcIso: string
): { recur: Recur; due: string; snapped: boolean } {
  validateRecur(recur);
  const { due, snapped } = firstOccurrence(recur, dueUtcIso);
  let resolvedRecur = recur;
  if (recur.freq === "monthly" && recur.byMonthDay === undefined) {
    const wall = getWallTime(due, recur.tz);
    resolvedRecur = { ...resolvedRecur, byMonthDay: wall.day };
  }
  // `anchor` is always the resolved first occurrence, unconditionally — it is server-derived
  // and callers must never set it themselves (see the field's own doc comment).
  resolvedRecur = { ...resolvedRecur, anchor: due };
  return { recur: resolvedRecur, due, snapped };
}

// Bounded walk-forward caps for nextOccurrence's daily/monthly branches (see doc comment on
// nextOccurrence for why a plain forward walk replaced the earlier closed-form estimate).
// Generous on purpose — cheap Intl-format iterations, not I/O — and sized so an interval:1
// series can catch up from a decades-old anchor in one call: 100000 days ~= 270 years,
// 5000 months ~= 416 years.
const DAILY_WALK_CAP = 100000;
const MONTHLY_WALK_CAP = 5000;

/**
 * Compute the next occurrence strictly after `afterUtcIso`, per `recur`.
 *
 * Everything here is measured from the series' fixed `recur.anchor` (its own first
 * occurrence, set once by `resolveRecurForCreate`) — NEVER from `afterUtcIso`'s own wall
 * time, except as the ">" comparison that picks which candidate to return. `afterUtcIso`
 * for a completed occurrence may be a snoozed `due` on a different date and/or time than
 * the series was ever meant to run on; a snooze must move only the snoozed occurrence
 * itself, and every later occurrence must stay exactly where the anchor says it belongs
 * (codex round-2/round-3 code review). `recur.anchor` is therefore required here — a recur
 * without one has never been through `resolveRecurForCreate` and cannot be scheduled;
 * silently falling back to `afterUtcIso`'s own wall time reintroduced every one of the bugs
 * this anchor design exists to prevent (design review, issue #9 round 4), so this throws
 * instead.
 *
 * Daily and monthly walk forward from the anchor in period-sized jumps, capped at
 * `DAILY_WALK_CAP` / `MONTHLY_WALK_CAP`, rather than estimating a starting `k` with a
 * closed-form approximation and correcting it — the estimate-and-correct shape was where two
 * of the three anchor-related regressions actually lived (which variable seeded the
 * calendar math), and a plain walk is simpler to verify correct by inspection while still
 * cheap in the common case (`nextFutureOccurrence` below passes `max(afterUtcIso, now)`, so
 * a typical call needs only a handful of iterations even for an old series).
 */
export function nextOccurrence(recur: Recur, afterUtcIso: string): string {
  if (recur.anchor === undefined) {
    throw new RangeError(
      "nextOccurrence requires recur.anchor to be set — call resolveRecurForCreate at creation time first."
    );
  }
  const interval = recur.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(`Invalid recur.interval ${JSON.stringify(interval)} — must be an integer >= 1.`);
  }
  const anchorWall = getWallTime(recur.anchor, recur.tz);
  const afterMs = new Date(afterUtcIso).getTime();
  const timeOfDay = { hour: anchorWall.hour, minute: anchorWall.minute, second: anchorWall.second };

  if (recur.freq === "daily") {
    for (let k = 0; k < DAILY_WALK_CAP; k++) {
      const candidate = wallTimeToUtcIso({ ...addCalDays(anchorWall, k * interval), ...timeOfDay }, recur.tz);
      if (new Date(candidate).getTime() > afterMs) return candidate;
    }
    throw new RangeError(
      `Could not find the next daily occurrence for recur ${JSON.stringify(recur)} after ${afterUtcIso} within ${DAILY_WALK_CAP} periods.`
    );
  }

  if (recur.freq === "weekly") {
    // The implicit single-weekday default is derived from the ANCHOR's weekday, never from
    // `afterUtcIso`'s — otherwise snoozing an occurrence to a different day of the week would
    // silently redefine which weekday an omitted `byWeekday` means going forward (codex
    // round-3 code review).
    const days = (recur.byWeekday?.length ? recur.byWeekday.map((w) => WEEKDAY_INDEX[w]) : [calWeekday(anchorWall)])
      .slice()
      .sort((a, b) => a - b);
    // Interval-week alignment is measured from the FIXED anchor, never re-derived per call
    // from whichever occurrence is being advanced from — a per-call reset breaks
    // multi-weekday rules: advancing from a Monday can find that same active week's
    // Wednesday first (correct), but a per-call anchor then treats THAT Wednesday as week 0
    // for its own call and matches the following Monday too, running every week instead of
    // the intended interval (codex round-2 code review).
    const anchorWeekMs = calDateToUtcMs(anchorWall.year, anchorWall.month, anchorWall.day);
    // The scan starts at `afterUtcIso`'s own calendar date (day 0, so a later occurrence on
    // the SAME day is reachable) and walks forward, testing the actual candidate INSTANT
    // against `afterMs` rather than just its calendar day — a same-day-but-earlier
    // `afterUtcIso` must be able to return a same-day occurrence, and near a DST transition
    // "the day after" in wall terms is not reliably "later" in UTC terms (design review,
    // issue #9 round 4). Bounded at `interval*7+8` regardless of how old the anchor is,
    // because phase is a modulo of a FIXED period, not a distance from the anchor.
    let candidate = getWallTime(afterUtcIso, recur.tz);
    const bound = interval * 7 + 8;
    for (let i = 0; i <= bound; i++) {
      const candidateMs = calDateToUtcMs(candidate.year, candidate.month, candidate.day);
      const weeksSinceAnchor = Math.floor((candidateMs - anchorWeekMs) / (7 * 86400000));
      // Modulo of a value that can be negative (a candidate before the anchor's own week, e.g.
      // when `afterUtcIso` predates `anchor`) must not be compared to 0 with JS's
      // sign-preserving `%`.
      const phase = ((weeksSinceAnchor % interval) + interval) % interval;
      if (days.includes(calWeekday(candidate)) && phase === 0) {
        const iso = wallTimeToUtcIso({ ...candidate, ...timeOfDay }, recur.tz);
        if (new Date(iso).getTime() > afterMs) return iso;
      }
      candidate = addCalDays(candidate, 1);
    }
    throw new RangeError(`Could not find the next weekly occurrence for recur ${JSON.stringify(recur)} after ${afterUtcIso}.`);
  }

  // monthly
  const targetDay = recur.byMonthDay ?? anchorWall.day;
  const anchorMonthIndex = anchorWall.year * 12 + (anchorWall.month - 1);
  for (let k = 0; k < MONTHLY_WALK_CAP; k++) {
    const idx = anchorMonthIndex + k * interval;
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    const day = Math.min(targetDay, daysInMonth(year, month));
    const candidate = wallTimeToUtcIso({ ...anchorWall, year, month, day, ...timeOfDay }, recur.tz);
    if (new Date(candidate).getTime() > afterMs) return candidate;
  }
  throw new RangeError(
    `Could not find the next monthly occurrence for recur ${JSON.stringify(recur)} after ${afterUtcIso} within ${MONTHLY_WALK_CAP} periods.`
  );
}

/**
 * The next occurrence that is both strictly after `afterUtcIso` (the series' own schedule)
 * and strictly after `nowUtcIso` ("skip missed slots, never schedule in the past") — i.e.
 * `nextOccurrence(recur, max(afterUtcIso, nowUtcIso))`. `nextOccurrence` itself is one bounded
 * walk from the anchor, so this needs no catch-up loop of its own: whichever of the two
 * instants is later already determines every candidate `nextOccurrence` must skip past.
 */
export function nextFutureOccurrence(recur: Recur, afterUtcIso: string, nowUtcIso: string): string {
  const afterMs = new Date(afterUtcIso).getTime();
  const nowMs = new Date(nowUtcIso).getTime();
  return nextOccurrence(recur, afterMs > nowMs ? afterUtcIso : nowUtcIso);
}

/**
 * Human-readable summary, e.g. "weekly SU 07:00 America/Phoenix" or "monthly 15 07:00 America/Phoenix".
 *
 * The displayed time-of-day (and any implicit weekday/day-of-month) always comes from
 * `recur.anchor`, never from a specific occurrence's `due` — otherwise a time-shifting
 * snooze would change the DISPLAYED rule even though the real schedule didn't move (codex
 * round-3 code review). Taking `recur` alone, rather than a caller-supplied due, removes the
 * chance of a call site passing the wrong instant (design review, issue #9 round 4) — the
 * old two-argument form fixed this correctly only at its one call site by convention.
 */
export function formatRecur(recur: Recur): string {
  if (recur.anchor === undefined) {
    throw new RangeError(
      "formatRecur requires recur.anchor to be set — call resolveRecurForCreate at creation time first."
    );
  }
  const wall = getWallTime(recur.anchor, recur.tz);
  const hh = String(wall.hour).padStart(2, "0");
  const mm = String(wall.minute).padStart(2, "0");
  const time = `${hh}:${mm}`;
  const intervalPrefix = recur.interval && recur.interval > 1 ? `every ${recur.interval} ` : "";

  if (recur.freq === "daily") {
    return `${intervalPrefix}daily ${time} ${recur.tz}`;
  }
  if (recur.freq === "weekly") {
    const days = recur.byWeekday?.length ? recur.byWeekday : [WEEKDAY_CODES[calWeekday(wall)]];
    return `${intervalPrefix}weekly ${days.join(",")} ${time} ${recur.tz}`;
  }
  const day = recur.byMonthDay ?? wall.day;
  return `${intervalPrefix}monthly ${day} ${time} ${recur.tz}`;
}
