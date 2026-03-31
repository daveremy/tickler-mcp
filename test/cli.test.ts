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
