import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  nextOccurrence,
  nextFutureOccurrence,
  firstOccurrence,
  isValidOccurrence,
  getWallTime,
  validateRecur,
  formatRecur,
  type Recur,
} from "../src/recur.js";

describe("recur: weekly", () => {
  test("weekly SU, interval 1: next occurrence is exactly 7 days later, same wall time", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    // 2026-09-13 was a Sunday. 07:00 Phoenix = 14:00Z (Phoenix has no DST, fixed UTC-7).
    const due = "2026-09-13T14:00:00.000Z";
    const next = nextOccurrence(recur, due);
    assert.equal(next, "2026-09-20T14:00:00.000Z");
    const wall = getWallTime(next, "America/Phoenix");
    assert.equal(wall.hour, 7);
    assert.equal(wall.minute, 0);
  });

  test("Phoenix has no DST: the UTC offset stays constant across a DST-transition date range", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    // 2026-03-01 (Sunday) 07:00 Phoenix, walk forward across the March 2026 US DST transition.
    let due = "2026-03-01T14:00:00.000Z"; // 07:00 MST (UTC-7)
    for (let i = 0; i < 5; i++) {
      const wall = getWallTime(due, "America/Phoenix");
      assert.equal(wall.hour, 7, `occurrence ${i} should read 07:00 in Phoenix`);
      assert.equal(due.slice(11, 13), "14", `occurrence ${i} should stay at a constant UTC offset (Phoenix has no DST)`);
      due = nextOccurrence(recur, due);
    }
  });
});

describe("recur: DST boundary (America/New_York)", () => {
  test("07:00 New York stays 07:00 local across the spring-forward boundary, UTC offset shifts", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/New_York" };
    // 2026-03-01 is a Sunday, before the 2026 US spring-forward (second Sunday in March = 2026-03-08).
    let due = "2026-03-01T12:00:00.000Z"; // 07:00 EST = UTC-5 -> 12:00Z
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

describe("recur: monthly", () => {
  test("byMonthDay 31 clamps in short months without losing the nominal day", () => {
    const recur: Recur = { freq: "monthly", byMonthDay: 31, tz: "America/Phoenix" };
    const jan31 = "2026-01-31T14:00:00.000Z"; // 07:00 Phoenix
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
});

describe("recur: missed-slot skip", () => {
  test("nextFutureOccurrence skips past several missed weekly slots to the next FUTURE one", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    const longAgo = "2020-01-05T14:00:00.000Z"; // a Sunday, far in the past
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
  test("formats a weekly rule with its time-of-day from due", () => {
    const recur: Recur = { freq: "weekly", byWeekday: ["SU"], tz: "America/Phoenix" };
    const due = "2026-09-13T14:00:00.000Z";
    assert.equal(formatRecur(recur, due), "weekly SU 07:00 America/Phoenix");
  });
});
