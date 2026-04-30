/**
 * Shared operational scaffolding for stdio watcher channels.
 *
 * `email-watcher.ts` and `gdrive-watcher.ts` both bring up the same boring
 * pieces around their domain logic:
 *
 *   - a Bun.serve health endpoint with a "stale" check based on
 *     `lastSuccessfulPollAt`
 *   - a singleton MCP client (with reset for tests)
 *   - a setInterval poll loop with try/catch logging
 *   - a `lastSuccessfulPollAt` timestamp the poll loop bumps
 *
 * This module owns those four things and nothing else.
 *
 * **Explicit non-goals.** This is not a "watcher framework". Domain logic —
 * Gmail vs Outlook polling, GDrive folder resolution, audit DB schemas,
 * channel tools — stays in each watcher. This file only removes the
 * literally-copy-pasted operational wiring.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Database } from "bun:sqlite";

// ── Health server ─────────────────────────────────────────────────────

export interface HealthServerOptions {
  /** Listen port. */
  port: number;
  /** Watcher-local DB to ping with `SELECT 1` as a liveness check. */
  db: Database;
  /** Returns ms since the last successful poll cycle. */
  getStaleMs: () => number;
  /** Threshold above which `getStaleMs()` should report unhealthy. */
  maxStaleMs: number;
  /** Logger for the boot message. */
  logger: { log(msg: string): void };
  /** Display name for the boot log. */
  name: string;
}

/**
 * Stand up a Bun.serve on `/health` with the standard staleness check.
 * Returns 200 OK on healthy, 503 with reason on stale or db-error.
 */
export function startHealthServer(opts: HealthServerOptions): void {
  Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        try {
          opts.db.query("SELECT 1").get();
          const staleMs = opts.getStaleMs();
          if (staleMs > opts.maxStaleMs) {
            return new Response(`stale: last poll ${Math.round(staleMs / 1000)}s ago`, { status: 503 });
          }
          return new Response("ok", { status: 200 });
        } catch {
          return new Response("db error", { status: 503 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  opts.logger.log(`[${opts.name}] Health server listening on :${opts.port} (/health)`);
}

// ── Managed MCP client ────────────────────────────────────────────────

export interface ManagedMcpClient {
  /** Connect on first call, return the cached client on subsequent calls. */
  get(): Promise<Client>;
  /** Drop the cached client. Used by tests and the MCP reconnect path. */
  reset(): void;
}

export interface ManagedMcpClientOptions {
  /** Logical client name (e.g. "gdrive-watcher-drive"). */
  name: string;
  /** Client semver. */
  version: string;
  /** MCP HTTP URL to connect to. */
  url: string;
  /** Optional debug log on connect. */
  logger?: { log(msg: string): void };
  /** Optional message logged on first successful connect. */
  connectMessage?: string;
}

/**
 * Build a singleton MCP client wrapper. The first `get()` call connects;
 * later calls return the cached instance. `reset()` drops the cache so a
 * subsequent `get()` reconnects (used by tests and by the MCP reconnect
 * path that recovers from server restarts).
 */
export function createManagedMcpClient(opts: ManagedMcpClientOptions): ManagedMcpClient {
  let client: Client | null = null;
  return {
    async get(): Promise<Client> {
      if (client) return client;
      const c = new Client({ name: opts.name, version: opts.version });
      const transport = new StreamableHTTPClientTransport(new URL(opts.url));
      await c.connect(transport);
      client = c;
      if (opts.logger && opts.connectMessage) {
        opts.logger.log(opts.connectMessage);
      }
      return c;
    },
    reset(): void {
      client = null;
    },
  };
}

// ── Poll loop ─────────────────────────────────────────────────────────

export interface PollLoopOptions {
  /** Display name for log messages. */
  name: string;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Async poll callback. The runtime catches and logs errors. */
  poll: () => Promise<void>;
  /** Logger for cycle errors. */
  logger: { log(msg: string): void };
  /** Run an immediate first cycle before starting the interval. */
  runFirstCycleImmediately?: boolean;
}

/**
 * Spin up a `setInterval` poll loop with the standard try/catch logging
 * the watchers used to inline. Optionally fires a first cycle immediately
 * (the way both watchers used to do during startup).
 *
 * Returns the interval handle so callers can clear it on shutdown.
 */
export async function startPollLoop(opts: PollLoopOptions): Promise<ReturnType<typeof setInterval>> {
  if (opts.runFirstCycleImmediately) {
    try {
      await opts.poll();
    } catch (e: any) {
      opts.logger.log(`[${opts.name}] First poll cycle error: ${e.message}`);
    }
  }

  const handle = setInterval(async () => {
    try {
      await opts.poll();
    } catch (e: any) {
      opts.logger.log(`[${opts.name}] Poll cycle error: ${e.message}`);
    }
  }, opts.intervalMs);
  return handle;
}
