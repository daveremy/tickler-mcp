import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  nextOccurrence,
  nextFutureOccurrence,
  firstOccurrence,
  resolveRecurForCreate,
  isValidOccurrence,
  getWallTime,
  validateRecur,
  formatRecur,
  type Recur,
} from "../src/recur.js";

describe("recur: weekly", () => {
  test("weekly SU, interval 1: next occurrence is exactly 7 days later, same wall time", () => {
    // 2026-09-13 was a Sunday. 07:00 Phoenix = 14:00Z (Phoenix has no DST, fixed UTC-7).
    const due = "2026-09-13T14:00:00.000Z";
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix", anchor: due };
    const next = nextOccurrence(recur, due);
    assert.equal(next, "2026-09-20T14:00:00.000Z");
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.hour, 7);
    assert.equal(wall.minute, 0);
  });

  test("Phoenix has no DST: the UTC offset stays constant across a DST-transition date range", () => {
    // 2026-03-01 (Sunday) 07:00 Phoenix, walk forward across the March 2026 US DST transition.
    let due = "2026-03-01T14:00:00.000Z"; // 07:00 MST (UTC-7)
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix", anchor: due };
    for (let i = 0; i < 5; i++) {
      const wall = getWallTime(due, "America/Phoenix");
      assert.equal(wall.hour, 7, `occurrence ${i} should read 07:00 in Phoenix`);
      assert.equal(due.slice(11, 13), "14", `occurrence ${i} should stay at a constant UTC offset (Phoenix has no DST)`);
      due = nextOccurrence(recur, due);
    }
  });

  test("weekly interval:2 stays exactly 14 days apart regardless of which week the series started in (codex round-1)", () => {
    // Two series starting on different Sundays (different weeks relative to any fixed epoch) —
    // if alignment were still keyed off a global epoch instead of the series' own start, one of
    // these would drift to a 7-day cadence instead of staying at 14.
    for (const start of ["2026-01-04T14:00:00.000Z", "2026-01-11T14:00:00.000Z"]) {
      const recur: Recur = { freq: "weekly", interval: 2, byWeekday: ["SU"], tz: "America/Phoenix", anchor: start };
      const first = nextOccurrence(recur, start);
      const second = nextOccurrence(recur, first);
      assert.equal(
        (new Date(first).getTime() - new Date(start).getTime()) / 86400000,
        14,
        `series starting ${start}: first occurrence should be 14 days later`
      );
      assert.equal(
        (new Date(second).getTime() - new Date(first).getTime()) / 86400000,
        14,
        `series starting ${start}: second occurrence should be another 14 days later`
      );
    }
  });

  test("weekly interval:2 with MULTIPLE weekdays stays on the correct active week, doesn't collapse to weekly (codex round-2)", () => {
    // Mon+Wed, every 2 weeks: an anchor-less per-call phase check finds Wed 2 days after Mon
    // (correct — same active week), but then treats THAT Wednesday as its own phase-zero and
    // matches the FOLLOWING Monday too (5 days later) — collapsing interval:2 into interval:1.
    const recur: Recur = { freq: "weekly", interval: 2, byWeekday: ["MO", "WE"], tz: "America/Phoenix" };
    const created = resolveRecurForCreate(recur, "2026-09-14T14:00:00.000Z"); // Monday, 07:00 Phoenix
    assert.equal(created.recur.anchor, created.due, "anchor must be set to the resolved first occurrence");

    const occurrences: string[] = [created.due];
    let current = created.due;
    for (let i = 0; i < 5; i++) {
      current = nextOccurrence(created.recur, current);
      occurrences.push(current);
    }
    const days = occurrences.map((iso) => getWallTime(iso, "America/Phoenix").day);
    // Active week 1: Mon 14, Wed 16. Skip week of 21/23. Active week 2: Mon 28, Wed 30.
    assert.deepEqual(days, [14, 16, 28, 30, 12, 14], "must alternate Mon/Wed pairs, skipping every other week");
  });
});

describe("recur: DST boundary (America/New_York)", () => {
  test("07:00 New York stays 07:00 local across the spring-forward boundary, UTC offset shifts", () => {
    // 2026-03-01 is a Sunday, before the 2026 US spring-forward (second Sunday in March = 2026-03-08).
    let due = "2026-03-01T12:00:00.000Z"; // 07:00 EST = UTC-5 -> 12:00Z
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/New_York", anchor: due };
    const offsets: string[] = [];
    for (let i = 0; i < 4; i++) {
      const wall = getWallTime(due, "America/New_York");
      assert.equal(wall.hour, 7, `occurrence ${i} should read 07:00 in New York`);
      offsets.push(due.slice(11, 13));
      due = nextOccurrence(recur, due);
    }
    // Before the transition: 12:00Z (EST, UTC-5). After: 11:00Z (EDT, UTC-4).
    assert.equal(offsets[0], "12", "pre-transition occurrence is EST (UTC-5)");
    assert.equal(offsets[offsets.length - 1], "11", "post-transition occurrence is EDT (UTC-4)");
  });
});

describe("recur: snooze-independent scheduling (codex round-3)", () => {
  test("daily interval:2 — a date-changing snoozed due does not shift the CALENDAR schedule", () => {
    // Anchor: Sep 14 07:00 Phoenix. Un-snoozed, occurrences land Sep14, 16, 18, ...
    // Snoozing the pending occurrence forward one day (to Sep 15) must not make the successor
    // land on Sep 17 — it must still be Sep 16, the anchor's own schedule.
    const recur: Recur = { freq: "daily", interval: 2, tz: "America/Phoenix", anchor: "2026-09-14T14:00:00.000Z" };
    const snoozedDue = "2026-09-15T14:00:00.000Z"; // 07:00 Phoenix, one day later than the anchor
    const next = nextOccurrence(recur, snoozedDue);
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.month, 9);
    assert.equal(wall.day, 16, "must land on the anchor's own Sep 16 slot, not Sep 17");
    assert.equal(wall.hour, 7, "must keep the anchor's 07:00, not whatever time the snooze landed on");
  });

  test("monthly day-31 — a date-changing snoozed due does not skip a clamped short month", () => {
    // Anchor: Jan 31 07:00 Phoenix. Un-snoozed, next occurrence is Feb 28 (clamped), not Mar 31.
    // Snoozing the pending occurrence forward one day (to Feb 1) must not make the successor
    // skip straight to Mar 31 — it must still be Feb 28.
    const recur: Recur = { freq: "monthly", byMonthDay: 31, tz: "America/Phoenix", anchor: "2026-01-31T14:00:00.000Z" };
    const snoozedDue = "2026-02-01T14:00:00.000Z"; // 07:00 Phoenix, one day later than the anchor
    const next = nextOccurrence(recur, snoozedDue);
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.month, 2, "must land in February, not skip to March");
    assert.equal(wall.day, 28, "must clamp to Feb 28, matching the un-snoozed schedule");
  });

  test("weekly with byWeekday omitted — a snoozed due does not redefine the implicit weekday", () => {
    // Anchor: Sunday 07:00 Phoenix, no byWeekday given (implicit weekday = the anchor's own).
    // Snoozing the pending occurrence to a Tuesday must not make the series a Tuesday series.
    const recur: Recur = { freq: "weekly", tz: "America/Phoenix", anchor: "2026-09-13T14:00:00.000Z" }; // Sunday
    const snoozedDue = "2026-09-15T14:00:00.000Z"; // Tuesday, same week
    const next = nextOccurrence(recur, snoozedDue);
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.day, 20, "must land on the following Sunday (Sep 20), not a Tuesday");
    assert.equal(
      new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay(),
      0,
      "must stay a Sunday series, not adopt the snoozed Tuesday"
    );
  });
});

describe("recur: monthly", () => {
  test("byMonthDay 31 clamps in short months without losing the nominal day", () => {
    const jan31 = "2026-01-31T14:00:00.000Z"; // 07:00 Phoenix
    const recur: Recur = { freq: "monthly", byMonthDay: 31, tz: "America/Phoenix", anchor: jan31 };
    const feb = nextOccurrence(recur, jan31);
    // Feb 2026 has 28 days.
    const febWall = getWallTime(feb, "America/Phoenix");
    assert.equal(febWall.month, 2);
    assert.equal(febWall.day, 28);

    const mar = nextOccurrence(recur, feb);
    const marWall = getWallTime(mar, "America/Phoenix");
    assert.equal(marWall.month, 3);
    assert.equal(marWall.day, 31, "the nominal day-31 rule must survive a clamped February, not drift to 28");
  });

  test("byMonthDay omitted: resolveRecurForCreate persists the default day so it survives a clamped February (codex round-1)", () => {
    // No byMonthDay given — the default must be resolved ONCE at create time (from due's
    // day-of-month) and persisted, not silently re-derived from each occurrence's own day.
    const recur: Recur = { freq: "monthly", tz: "America/Phoenix" };
    const jan31 = "2026-01-31T14:00:00.000Z"; // 07:00 Phoenix, day 31
    const created = resolveRecurForCreate(recur, jan31);
    assert.equal(created.snapped, false);
    assert.equal(created.recur.byMonthDay, 31, "byMonthDay must be persisted as 31, not left undefined");

    const feb = nextOccurrence(created.recur, created.due);
    const febWall = getWallTime(feb, "America/Phoenix");
    assert.equal(febWall.month, 2);
    assert.equal(febWall.day, 28, "Feb 2026 has 28 days, so this occurrence clamps");

    // The bug: a re-derived default (from Feb's clamped day 28) would keep the series pinned
    // at 28 forever instead of returning to the nominal 31 once a 31-day month arrives.
    const mar = nextOccurrence(created.recur, feb);
    const marWall = getWallTime(mar, "America/Phoenix");
    assert.equal(marWall.month, 3);
    assert.equal(marWall.day, 31, "must return to day 31 in March, not drift to 28");
  });
});

describe("recur: missed-slot skip", () => {
  test("nextFutureOccurrence skips past several missed weekly slots to the next FUTURE one", () => {
    const longAgo = "2020-01-05T14:00:00.000Z"; // a Sunday, far in the past
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix", anchor: longAgo };
    const now = "2026-09-15T00:00:00.000Z";
    const next = nextFutureOccurrence(recur, longAgo, now);
    assert.ok(new Date(next).getTime() > new Date(now).getTime(), "result must be strictly after now");
    // And it must be the *next* Sunday after now, not some arbitrary future one.
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.hour, 7);
  });
});

describe("recur: firstOccurrence snapping", () => {
  test("a due that doesn't match the rule snaps forward to the next valid occurrence, same time-of-day", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    // 2026-09-15 is a Tuesday.
    const tuesday = "2026-09-15T14:00:00.000Z";
    const result = firstOccurrence(recur, tuesday);
    assert.equal(result.snapped, true);
    const wall = getWallTime(result.due, "America/Phoenix");
    assert.equal(wall.hour, 7);
    assert.ok(isValidOccurrence(recur, wall));
  });

  test("a due that already matches the rule is returned unchanged", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    const sunday = "2026-09-13T14:00:00.000Z";
    const result = firstOccurrence(recur, sunday);
    assert.equal(result.snapped, false);
    assert.equal(result.due, sunday);
  });
});

describe("recur: validation", () => {
  test("rejects a bad timezone", () => {
    assert.throws(() => validateRecur({ freq: "daily", tz: "Not/AZone" } as Recur), RangeError);
  });
  test("rejects interval < 1", () => {
    assert.throws(() => validateRecur({ freq: "daily", interval: 0, tz: "America/Phoenix" }), RangeError);
  });
  test("rejects an invalid byMonthDay", () => {
    assert.throws(() => validateRecur({ freq: "monthly", byMonthDay: 32, tz: "America/Phoenix" }), RangeError);
  });
  test("accepts a well-formed weekly rule", () => {
    assert.doesNotThrow(() => validateRecur({ freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" }));
  });
});

describe("recur: formatRecur", () => {
  test("formats a weekly rule with its time-of-day from the series anchor", () => {
    const due = "2026-09-13T14:00:00.000Z";
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix", anchor: due };
    assert.equal(formatRecur(recur), "weekly SU 07:00 America/Phoenix");
  });
});

describe("recur: anchor is required for scheduling/display (design review, issue #9 round 4)", () => {
  test("nextOccurrence throws a clear RangeError when recur.anchor is missing", () => {
    const recur: Recur = { freq: "daily", tz: "America/Phoenix" };
    assert.throws(() => nextOccurrence(recur, "2026-09-13T14:00:00.000Z"), /requires recur\.anchor/);
  });

  test("formatRecur throws a clear RangeError when recur.anchor is missing", () => {
    const recur: Recur = { freq: "daily", tz: "America/Phoenix" };
    assert.throws(() => formatRecur(recur), /requires recur\.anchor/);
  });

  test("nextOccurrence rejects a corrupted interval:0 instead of hanging", () => {
    const anchor = "2026-09-13T14:00:00.000Z";
    const recur: Recur = { freq: "monthly", interval: 0, tz: "America/Phoenix", anchor };
    assert.throws(() => nextOccurrence(recur, anchor), RangeError);
  });
});

describe("recur: interval combined with byMonthDay (design review, issue #9 round 4)", () => {
  test("every 2 months on the 31st always clamps from the nominal day, skipping the months in between", () => {
    const anchor = "2026-01-31T14:00:00.000Z"; // Jan 31, 07:00 Phoenix
    const recur: Recur = { freq: "monthly", interval: 2, byMonthDay: 31, tz: "America/Phoenix", anchor };
    const occurrences: Array<{ month: number; day: number }> = [];
    let current = anchor;
    for (let i = 0; i < 3; i++) {
      current = nextOccurrence(recur, current);
      const wall = getWallTime(current, "America/Phoenix");
      occurrences.push({ month: wall.month, day: wall.day });
    }
    // Jan -> Mar (31) -> May (31) -> Jul (31); February/April/June are never visited, and the
    // nominal day never drifts to a clamped one even though March/May/July all have 31 days.
    assert.deepEqual(occurrences, [
      { month: 3, day: 31 },
      { month: 5, day: 31 },
      { month: 7, day: 31 },
    ]);
  });
});

describe("recur: weekly can return a same-day later occurrence (design review, issue #9 round 4)", () => {
  test("advancing from earlier the same day returns that same calendar day, not the day after", () => {
    // Anchor Sunday 07:00 Phoenix. Advancing from 06:00 the same Sunday must return that same
    // Sunday at 07:00 — the old day-granularity scan always skipped to the following week.
    const anchor = "2026-09-13T14:00:00.000Z"; // Sunday 07:00 Phoenix
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix", anchor };
    const earlierSameDay = "2026-09-13T13:00:00.000Z"; // Sunday 06:00 Phoenix
    const next = nextOccurrence(recur, earlierSameDay);
    assert.equal(next, anchor, "must return the same Sunday's 07:00 occurrence, not skip to next week");
  });
});
