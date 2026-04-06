/**
 * Tests for the shared watcher runtime helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createManagedMcpClient, startPollLoop } from "./watcher-runtime";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => {
  db.close();
});

// ── createManagedMcpClient ────────────────────────────────────────────

describe("createManagedMcpClient", () => {
  test("returns a wrapper with .get() and .reset()", () => {
    const wrapper = createManagedMcpClient({
      name: "test",
      version: "0.0.1",
      url: "http://example/mcp",
    });
    expect(typeof wrapper.get).toBe("function");
    expect(typeof wrapper.reset).toBe("function");
    // reset() before any get() is a no-op (must not throw)
    wrapper.reset();
  });

  // Caching/reconnect behavior is exercised end-to-end by
  // email-watcher.integration.test.ts and gdrive-watcher.integration.test.ts
  // which run real MCP roundtrips against mock servers.
});

// ── startPollLoop ─────────────────────────────────────────────────────

describe("startPollLoop", () => {
  test("runs first cycle immediately when requested, then schedules interval", async () => {
    let calls = 0;
    const handle = await startPollLoop({
      name: "test",
      intervalMs: 1_000_000, // huge so the interval doesn't fire during the test
      poll: async () => {
        calls++;
      },
      logger: { log() {} },
      runFirstCycleImmediately: true,
    });

    expect(calls).toBe(1);
    clearInterval(handle);
  });

  test("does NOT run first cycle when runFirstCycleImmediately=false", async () => {
    let calls = 0;
    const handle = await startPollLoop({
      name: "test",
      intervalMs: 1_000_000,
      poll: async () => {
        calls++;
      },
      logger: { log() {} },
      runFirstCycleImmediately: false,
    });

    expect(calls).toBe(0);
    clearInterval(handle);
  });

  test("logs and swallows poll errors", async () => {
    let logged = "";
    let calls = 0;
    const handle = await startPollLoop({
      name: "test",
      intervalMs: 1_000_000,
      poll: async () => {
        calls++;
        throw new Error("boom");
      },
      logger: { log: (m: string) => { logged = m; } },
      runFirstCycleImmediately: true,
    });

    expect(calls).toBe(1);
    expect(logged).toContain("First poll cycle error");
    expect(logged).toContain("boom");
    clearInterval(handle);
  });
});
