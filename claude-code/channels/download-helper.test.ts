import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileAsDownload } from "./download-helper";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "download-helper-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("readFileAsDownload", () => {
  test("reads PDF file and returns base64 + metadata", () => {
    const pdfContent = Buffer.from("%PDF-1.4 fake content");
    const filePath = join(tmpDir, "test.pdf");
    writeFileSync(filePath, pdfContent);

    const result = readFileAsDownload(filePath);

    expect(result.filename).toBe("test.pdf");
    expect(result.content_base64).toBe(pdfContent.toString("base64"));
    expect(result.content_type).toBe("application/pdf");
    expect(result.size).toBe(pdfContent.length);
  });

  test("detects JPEG content type", () => {
    const filePath = join(tmpDir, "photo.jpg");
    writeFileSync(filePath, Buffer.from("fake jpeg"));

    const result = readFileAsDownload(filePath);
    expect(result.content_type).toBe("image/jpeg");
  });

  test("detects PNG content type", () => {
    const filePath = join(tmpDir, "image.png");
    writeFileSync(filePath, Buffer.from("fake png"));

    const result = readFileAsDownload(filePath);
    expect(result.content_type).toBe("image/png");
  });

  test("throws for nonexistent file", () => {
    expect(() => readFileAsDownload("/nonexistent/file.pdf")).toThrow();
  });
});
