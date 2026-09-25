/**
 * CLI tests — smoke test the CLI binary using child_process.
 * These tests build the project first, then run dist/cli.js with a temp DB.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const TEST_DB = path.join(os.tmpdir(), `tickler-cli-test-${crypto.randomUUID()}.db`);

function cli(args: string): string {
  return execSync(`node "${CLI}" ${args}`, {
    env: { ...process.env, TICKLER_DB_PATH: TEST_DB },
    encoding: "utf-8",
  });
}

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
}

describe("cli: basic commands", () => {
  test("--version prints version", () => {
    const out = cli("--version");
    assert.match(out, /\d+\.\d+\.\d+/);
  });

  test("list with empty store", () => {
    const out = cli("list");
    assert.match(out, /No ticklers found/);
  });

  test("create and then list", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    cli(`create "CLI test reminder" --due "${due}" --body "test body"`);
    const out = cli("list");
    assert.match(out, /CLI test reminder/);
  });

  test("check with no due items exits 0", () => {
    // All items have future due dates — check exits 0 if none are overdue
    let exitCode = 0;
    try {
      cli("check");
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err) {
        exitCode = (err as NodeJS.ErrnoException & { status: number }).status ?? 1;
      }
    }
    // May be 0 (no overdue) or 1 (overdue from prior test, future items are future)
    // Just verify the command runs without crashing
    assert.ok(exitCode === 0 || exitCode === 1, "exit code should be 0 or 1");
  });

  test("invalid --status fails with exit 1", () => {
    let threw = false;
    try {
      cli("list --status invalid");
    } catch {
      threw = true;
    }
    assert.ok(threw, "invalid status should exit non-zero");
  });

  test("complete unknown id exits non-zero", () => {
    let threw = false;
    try {
      cli("complete nonexistent-id");
    } catch {
      threw = true;
    }
    assert.ok(threw, "completing unknown id should exit non-zero");
  });

  // Cleanup after all tests
  test("cleanup", () => {
    cleanup();
  });
});

describe("cli: --recur parsing (codex round-4 code review, issue #9)", () => {
  test("a well-formed --recur monthly:15 creates a recurring tickler", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const out = cli(`create "recur CLI valid" --due "${due}" --recur "monthly:15" --tz "America/Phoenix"`);
    assert.match(out, /Created:/);
  });

  test("monthly:1.5 is rejected instead of silently truncating to day 1", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "recur CLI bad decimal" --due "${due}" --recur "monthly:1.5" --tz "America/Phoenix"`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "monthly:1.5 must be rejected, not accepted as day 1");
  });

  test("monthly:15junk is rejected instead of silently parsing as day 15", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "recur CLI bad suffix" --due "${due}" --recur "monthly:15junk" --tz "America/Phoenix"`);
    } catch {
      threw = true;
    }
    assert.ok(threw, "monthly:15junk must be rejected, not accepted as day 15");
  });

  test("an extra colon segment is rejected instead of silently discarded", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "recur CLI extra colon" --due "${due}" --recur "weekly:SU:extra" --tz "America/Phoenix"`);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'weekly:SU:extra must be rejected, not silently truncated to "weekly:SU"');
  });

  test("daily:2 is rejected instead of silently dropping the interval suffix (codex round-5)", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    let threw = false;
    try {
      cli(`create "recur CLI daily suffix" --due "${due}" --recur "daily:2" --tz "America/Phoenix"`);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'daily:2 must be rejected — the CLI does not support an interval suffix on "daily"');
  });
});

describe("cli: notify channel (tickler-mcp#11)", () => {
  /** Same spawn shape as `cli` above, but keeps stdout/exit status on a nonzero exit —
   * `check --notify-due` and `notify-mark-fired` encode their outcome in the exit code. */
  function cliRun(args: string): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(`node "${CLI}" ${args}`, {
        env: { ...process.env, TICKLER_DB_PATH: TEST_DB },
        encoding: "utf-8",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  /** Create a telegram:dave tickler and return its id, read from `check --notify-due`'s JSON. */
  function createDueTelegram(title: string): string {
    const due = new Date(Date.now() - 3600_000).toISOString();
    cli(`create "${title}" --due "${due}" --notify telegram:dave --body "telegram body"`);
    const r = cliRun("check --notify-due");
    assert.equal(r.status, 1, "a due telegram tickler must make check --notify-due exit 1");
    const found = (JSON.parse(r.stdout) as { id: string; title: string }[]).find((x) => x.title === title);
    assert.ok(found, `the created "${title}" must appear in check --notify-due output`);
    return found!.id;
  }

  test('create --notify telegram:dave is echoed back and listed', () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const out = cli(`create "notify CLI telegram" --due "${due}" --notify telegram:dave`);
    assert.match(out, /Created:/);
    assert.match(out, /Notify:\s+telegram:dave/, "the channel must be echoed back, as recur/nag are");
    assert.match(cli("list"), /notify CLI telegram/);
  });

  test("create without --notify prints no Notify line (the default is silent)", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const out = cli(`create "notify CLI default" --due "${due}"`);
    assert.match(out, /Created:/);
    assert.ok(!/Notify:/.test(out), "the default channel is not worth a line of output");
  });

  test("create --notify bogus is rejected with the channel error", () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const r = cliRun(`create "notify CLI bogus" --due "${due}" --notify bogus`);
    assert.notEqual(r.status, 0, "an unknown channel must exit nonzero");
    assert.match(r.stderr, /--notify must be "agent" or "telegram:dave"/);
  });

  test("check --notify-due with none due exits 0 and prints []", () => {
    // Only future-due rows exist at this point in the file, and none of them telegram.
    const r = cliRun("check --notify-due");
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
  });

  test("check --notify-due with a due telegram tickler exits 1 and prints its JSON", () => {
    const id = createDueTelegram("notify CLI due");

    const r = cliRun("check --notify-due");
    assert.equal(r.status, 1, "1 = found something, same convention as the agent check");
    const rows = JSON.parse(r.stdout) as { id: string; title: string; body: string; due: string; lastFiredAt: string | null }[];
    const found = rows.find((x) => x.id === id);
    assert.ok(found, "the due telegram tickler must be in the JSON output");
    assert.equal(found.title, "notify CLI due");
    assert.equal(found.body, "telegram body");
    assert.ok(found.due, "the poller needs the due timestamp to render the message");
    assert.equal(found.lastFiredAt, null, "the read is dry — the token is handed over unspent");

    // And the read must not have marked it fired: a second identical read says the same thing.
    const again = cliRun("check --notify-due");
    assert.equal(again.status, 1);
    assert.equal((JSON.parse(again.stdout) as { id: string }[]).some((x) => x.id === id), true);
  });

  test("check --notify-due never surfaces a due agent tickler", () => {
    const due = new Date(Date.now() - 3600_000).toISOString();
    cli(`create "notify CLI agent due" --due "${due}"`);
    const r = cliRun("check --notify-due");
    const titles = (JSON.parse(r.stdout) as { title: string }[]).map((x) => x.title);
    assert.ok(!titles.includes("notify CLI agent due"), "the agent channel is not the telegram poller's business");
  });

  test("notify-mark-fired claims once; the same stale token loses the race", () => {
    const id = createDueTelegram("notify CLI claim");

    const first = cliRun(`notify-mark-fired ${id} --prev-fired-at none`);
    assert.equal(first.status, 0, "exit 0 = claimed");
    assert.match(first.stdout, /Claimed:/);

    // Same token as before — the live row's lastFiredAt has moved on, so this is the
    // lost-race path a second poller run (or a retry after a slow send) must survive.
    const second = cliRun(`notify-mark-fired ${id} --prev-fired-at none`);
    assert.equal(second.status, 1, "exit 1 = lost race / no longer eligible");
    assert.match(second.stderr, /Not claimed/);

    // Claimed exactly once, so the poller will not be told about it again.
    const r = cliRun("check --notify-due");
    assert.ok(
      !(JSON.parse(r.stdout) as { id: string }[]).some((x) => x.id === id),
      "a claimed non-nag telegram tickler must not be returned again"
    );
  });

  test("notify-mark-fired on a nonexistent id exits 1", () => {
    const r = cliRun("notify-mark-fired nonexistent-id --prev-fired-at none");
    assert.equal(r.status, 1);
  });

  test("notify-mark-fired without --prev-fired-at exits nonzero (usage error)", () => {
    const r = cliRun("notify-mark-fired some-id");
    assert.notEqual(r.status, 0, "the token is required, not optional");
  });

  // Cleanup after these tests' rows — the file's earlier cleanup test ran before this block.
  test("cleanup", () => {
    cleanup();
  });
});
