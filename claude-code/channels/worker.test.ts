import { describe, it, expect } from "bun:test";
import {
  sweepStaleGuidance,
  GUIDANCE_REMINDER_HOURS,
  GUIDANCE_TIMEOUT_HOURS,
  GUIDANCE_REMINDER_COOLDOWN_HOURS,
  buildNotifyTelegram,
} from "./worker";

describe("worker module exports", () => {
  it("re-exports sweepStaleGuidance and constants", () => {
    expect(typeof sweepStaleGuidance).toBe("function");
    expect(GUIDANCE_REMINDER_HOURS).toBe(24);
    expect(GUIDANCE_TIMEOUT_HOURS).toBe(72);
    expect(GUIDANCE_REMINDER_COOLDOWN_HOURS).toBe(6);
  });

  it("buildNotifyTelegram returns a no-op when env vars are missing", async () => {
    const notify = buildNotifyTelegram(undefined, undefined, () => {});
    await expect(notify("test")).resolves.toBeUndefined();
  });

  it("buildNotifyTelegram returns a function that calls fetch when env vars set", async () => {
    let fetched = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched += 1; return new Response("ok"); };
    try {
      const notify = buildNotifyTelegram("token", "chat", () => {});
      await notify("hi");
      expect(fetched).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // fetch() does not reject on HTTP 4xx/5xx, so a rejected chat_id or a revoked
  // bot token used to be swallowed with no log line at all -- the exact cases the
  // "Telegram notification failed" alert exists to catch.
  it("buildNotifyTelegram logs when Telegram returns a non-OK status", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 });
    try {
      const logs: string[] = [];
      const notify = buildNotifyTelegram("token", "bad-chat", (m) => logs.push(m));
      await notify("hi");
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("Telegram notification failed");
      expect(logs[0]).toContain("HTTP 400");
      expect(logs[0]).toContain("chat not found");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("buildNotifyTelegram stays silent on a successful send", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
    try {
      const logs: string[] = [];
      const notify = buildNotifyTelegram("token", "chat", (m) => logs.push(m));
      await notify("hi");
      expect(logs).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("buildNotifyTelegram still logs on a network-level rejection", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const logs: string[] = [];
      const notify = buildNotifyTelegram("token", "chat", (m) => logs.push(m));
      await notify("hi");
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("Telegram notification failed");
      expect(logs[0]).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
