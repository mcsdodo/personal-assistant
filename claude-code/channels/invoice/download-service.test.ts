import { afterEach, describe, expect, test } from "bun:test";
import { downloadInvoice } from "./download-service";

// NFD: ľ = l (U+006C) + combining caron (U+030C); č = c (U+0063) + U+030C.
// download-service must preserve whatever bytes the source returned — sanitisation
// of the on-disk path happens in intake-worker.ts (uses job.id + extension).
const NFD_FILENAME = "diaľničnej.pdf";

function rpcText(text: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  };
}

function jsonRpc(value: unknown) {
  return rpcText(JSON.stringify(value));
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

function mockFetch(...responses: Response[]) {
  let i = 0;
  globalThis.fetch = (async () => {
    if (i >= responses.length) throw new Error(`Unexpected fetch call #${i}`);
    return responses[i++];
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadInvoice — preserves source filename verbatim", () => {
  test("Outlook attachment: NFD bytes survive unchanged", async () => {
    mockFetch(
      jsonResp(jsonRpc([{ id: "att-1", name: NFD_FILENAME, content_type: "application/pdf", size: 100 }])),
      jsonResp(jsonRpc({ name: NFD_FILENAME, content_type: "application/pdf", size: 100, content_base64: "AA==" })),
    );

    const file = await downloadInvoice(
      { email_source: "outlook", message_id: "msg-1" },
      { sender: null, subject: null, download_strategy: "attachment" },
      { gmail: "http://gmail-mcp:8000/mcp", outlook: "http://outlook-mcp:8002/mcp" },
      "user@example.com",
      { log: () => {} },
    );

    expect(file.filename).toBe(NFD_FILENAME);
  });

  test("Gmail attachment (HTTP mode): NFD bytes survive unchanged", async () => {
    const attachmentListing = `--- ATTACHMENTS ---\n1. ${NFD_FILENAME} (application/pdf, 45.6 KB)\n   Attachment ID: att-nfd\n`;
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

    mockFetch(
      jsonResp(rpcText(attachmentListing)),
      jsonResp(rpcText("Download URL: http://fake-dl-host/attachment.bin")),
      new Response(pdfBytes, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );

    const file = await downloadInvoice(
      { email_source: "gmail", message_id: "msg-gmail-1" },
      { sender: null, subject: null, download_strategy: "attachment" },
      { gmail: "http://gmail-mcp:8000/mcp", outlook: "http://outlook-mcp:8002/mcp" },
      "user@example.com",
      { log: () => {} },
    );

    expect(file.filename).toBe(NFD_FILENAME);
  });
});
