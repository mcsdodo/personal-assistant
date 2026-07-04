/**
 * MCP Server configuration.
 *
 * Extracted from intake-worker.ts as part of Phase 2 decomposition (task 102).
 */

export const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
export const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
export const GOOGLE_EMAIL = process.env.GMAIL_EMAIL ?? "";
