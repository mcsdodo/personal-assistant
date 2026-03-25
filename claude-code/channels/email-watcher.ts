#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const POLL_INTERVAL_MS = 60_000; // 60 seconds for POC

const MOCK_EMAILS = [
  {
    sender: "alza@alza.sk",
    subject: "Faktúra č. FA2026030123",
    attachment: "invoice_FA2026030123.pdf",
    body: "Dobrý deň, v prílohe posielame faktúru za objednávku #12345. Suma: 47.50 EUR.",
  },
  {
    sender: "fakturacia@orange.sk",
    subject: "Vaša faktúra za 03/2026",
    attachment: "orange_faktura_032026.pdf",
    body: "Vážený zákazník, faktúra za mesiac marec 2026 je v prílohe. Suma: 29.99 EUR.",
  },
  {
    sender: "noreply@digitalocean.com",
    subject: "Your invoice for March 2026",
    attachment: "digitalocean_invoice_2026-03.pdf",
    body: "Hi, your invoice for March 2026 is attached. Total: $12.00.",
  },
];

const mcp = new Server(
  { name: "email-watcher", version: "0.0.1" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      'Events from email-watcher arrive as <channel source="email-watcher" sender="..." subject="...">. ' +
      "Each event represents a new invoice email detected. Classify it and process using available tools. " +
      "These are one-way events: read them and act, no reply through this channel.",
  }
);

await mcp.connect(new StdioServerTransport());

// POC: cycle through mock emails, one per interval
let emailIndex = 0;

setInterval(async () => {
  const email = MOCK_EMAILS[emailIndex % MOCK_EMAILS.length];
  emailIndex++;

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `New invoice email:\nFrom: ${email.sender}\nSubject: ${email.subject}\nAttachment: ${email.attachment}\n\n${email.body}`,
      meta: {
        sender: email.sender,
        subject: email.subject,
        has_attachment: "true",
        attachment_name: email.attachment,
        timestamp: new Date().toISOString(),
      },
    },
  });
}, POLL_INTERVAL_MS);
