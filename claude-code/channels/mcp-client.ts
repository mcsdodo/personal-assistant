/**
 * Lightweight MCP HTTP client for calling Streamable HTTP MCP tool servers.
 *
 * Used by the workflow worker to call gmail/outlook/paperless MCPs directly,
 * without going through the Claude session.
 */

import { getTracer, withSpan, injectTraceHeaders } from "./tracing";
import type { Span, Tracer } from "./tracing";

const tracer = getTracer("mcp-client");

/** Extract service name from MCP URL: "http://gmail-mcp:8000/mcp" → "gmail-mcp" */
function serverName(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * Thrown when an MCP tool returns `isError: true`. Before this class existed,
 * `extractText` silently returned the error payload as if it were tool output
 * and callers type-asserted their way into `{id: undefined}`, which caused
 * 17 production documents to be uploaded with `correspondent: null`. See task 48.
 */
export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly payload: string,
  ) {
    super(`MCP tool ${toolName} returned isError: ${payload.slice(0, 300)}`);
    this.name = "McpToolError";
  }
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/**
 * Throw `McpToolError` if a tool result has `isError: true`. Callers should
 * invoke this right after receiving a result from `callMcpTool` if they plan
 * to parse the payload as tool output — otherwise errors silently leak into
 * `extractText` and get JSON.parse()'d as if they were valid responses.
 */
function throwIfError(toolName: string, result: McpToolResult): void {
  if (result.isError) {
    const payload = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    throw new McpToolError(toolName, payload);
  }
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: McpToolResult;
  error?: { code: number; message: string; data?: unknown };
}

let requestId = 0;

/** Max retries for transient network errors (connection refused, DNS failures). */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Check if an error is a transient network error worth retrying.
 * Bun's fetch throws these when the TCP connection itself fails.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("unable to connect") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("dns") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    (error as any).code === "ConnectionRefused" ||
    (error as any).code === "ECONNREFUSED" ||
    (error as any).code === "ENOTFOUND"
  );
}

/**
 * Call an MCP tool on a Streamable HTTP server.
 *
 * For stateless servers (outlook-mcp, checker-mcp with FASTMCP_STATELESS_HTTP=true),
 * this is a simple POST. For stateful servers (paperless-mcp, gmail-mcp), an MCP
 * session may be needed — we initialize one on first call.
 *
 * Retries transient network errors (connection refused, DNS failures) up to 3 times
 * with exponential backoff. This handles cases where Docker DNS or a container
 * isn't fully ready yet.
 */
export async function callMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const server = serverName(serverUrl);
  return withSpan(tracer, `mcp ${server} ${toolName}`, {
    "mcp.server": server,
    "mcp.tool": toolName,
  }, async (span) => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          span.addEvent("retry", { attempt, delay_ms: delay });
          await new Promise((r) => setTimeout(r, delay));
        }

        const result = await callMcpToolOnce(serverUrl, toolName, args, span);
        // Surface tool-level errors instead of silently returning them as
        // if they were valid output. See McpToolError doc above.
        throwIfError(toolName, result);
        if (attempt > 0) {
          span.setAttribute("mcp.retries", attempt);
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // McpToolError is a business-level failure (400, duplicate, etc.) —
        // don't retry, just propagate.
        if (error instanceof McpToolError) throw lastError;
        if (!isTransientNetworkError(error) || attempt === MAX_RETRIES) {
          throw lastError;
        }
        // Log retry for observability
        span.addEvent("transient_error", {
          attempt,
          error: lastError.message,
        });
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError ?? new Error("MCP call failed after retries");
  });
}

/**
 * Single attempt to call an MCP tool. Handles stateless vs stateful servers.
 */
async function callMcpToolOnce(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  span: Span,
): Promise<McpToolResult> {
  const id = ++requestId;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  injectTraceHeaders(headers);

  // Try direct tool call first (works for stateless servers)
  const response = await fetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!response.ok) {
    // If we get a 400/405, the server may need initialization first
    if (response.status === 400 || response.status === 405) {
      return callMcpToolWithSession(serverUrl, toolName, args);
    }
    span.setAttribute("http.status_code", response.status);
    throw new Error(`MCP call failed: ${response.status} ${response.statusText}`);
  }

  span.setAttribute("http.status_code", response.status);

  const contentType = response.headers.get("content-type") ?? "";

  // Handle SSE response (some servers use text/event-stream)
  if (contentType.includes("text/event-stream")) {
    return parseSseResponse(response);
  }

  // Handle plain JSON response
  const json = (await response.json()) as McpJsonRpcResponse;
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return json.result!;
}

/**
 * Call with full MCP session handshake (initialize → tool call).
 * Needed for stateful servers like paperless-mcp and gmail-mcp.
 */
async function callMcpToolWithSession(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const server = serverName(serverUrl);
  return withSpan(tracer, `mcp ${server} ${toolName} (session)`, {
    "mcp.server": server,
    "mcp.tool": toolName,
  }, async (span) => {
    // Step 1: Initialize
    const initId = ++requestId;
    const initHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    injectTraceHeaders(initHeaders);

    const initResponse = await fetch(serverUrl, {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "workflow-worker", version: "0.1.0" },
        },
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`MCP initialize failed: ${initResponse.status} ${initResponse.statusText}`);
    }

    // Extract session ID from response header
    const sessionId = initResponse.headers.get("mcp-session-id");

    // Parse init response (may be SSE or JSON)
    const initContentType = initResponse.headers.get("content-type") ?? "";
    if (initContentType.includes("text/event-stream")) {
      await parseSseResponse(initResponse); // consume but don't need the result
    } else {
      await initResponse.json(); // consume
    }

    // Step 2: Send initialized notification
    const notifHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) notifHeaders["mcp-session-id"] = sessionId;
    injectTraceHeaders(notifHeaders);

    await fetch(serverUrl, {
      method: "POST",
      headers: notifHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // Step 3: Call the tool
    const callId = ++requestId;
    const callHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) callHeaders["mcp-session-id"] = sessionId;
    injectTraceHeaders(callHeaders);

    const callResponse = await fetch(serverUrl, {
      method: "POST",
      headers: callHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    span.setAttribute("http.status_code", callResponse.status);

    if (!callResponse.ok) {
      throw new Error(`MCP tool call failed: ${callResponse.status} ${callResponse.statusText}`);
    }

    const callContentType = callResponse.headers.get("content-type") ?? "";
    if (callContentType.includes("text/event-stream")) {
      return parseSseResponse(callResponse);
    }

    const json = (await callResponse.json()) as McpJsonRpcResponse;
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    return json.result!;
  });
}

/**
 * Parse a Server-Sent Events response from an MCP server.
 * Extracts the JSON-RPC result from the event stream.
 */
async function parseSseResponse(response: Response): Promise<McpToolResult> {
  const text = await response.text();
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as McpJsonRpcResponse;
        if (json.result) return json.result;
        if (json.error) {
          throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("MCP error")) throw e;
        // Skip non-JSON lines
      }
    }
  }

  throw new Error("No result found in SSE response");
}

/**
 * Extract text content from an MCP tool result.
 */
export function extractText(result: McpToolResult): string {
  return result.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

/**
 * Extract and parse JSON from an MCP tool result text content.
 */
export function extractJson<T>(result: McpToolResult): T {
  const text = extractText(result);
  return JSON.parse(text) as T;
}
