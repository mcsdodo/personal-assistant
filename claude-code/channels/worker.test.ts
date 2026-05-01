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
});
