import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { readFileAsDownload, tryDecrypt } from "./download-helper";

/** Resolve full path to bun executable (needed for Bun.spawnSync on Windows). */
const BUN_EXE = join(homedir(), ".bun", "bin", "bun.exe");

/** Absolute import path for download-helper (used in subprocess helper scripts). */
const DOWNLOAD_HELPER_PATH = join(import.meta.dir, "download-helper").replace(/\\/g, "/");

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

describe("tryDecrypt", () => {
  // BANK_PDF_PASSWORD is captured at module scope from process.env.BANK_PDF_PASSWORD.
  // In the test environment it is unset (empty string), so tryDecrypt takes the
  // early-return path and never shells out to qpdf.

  test("is a no-op when BANK_PDF_PASSWORD is empty (file unchanged)", () => {
    const pdfContent = Buffer.from("%PDF-1.4 fake content");
    const filePath = join(tmpDir, "invoice.pdf");
    writeFileSync(filePath, pdfContent);

    tryDecrypt(filePath);

    // File must be identical — no decryption attempted
    const after = readFileSync(filePath);
    expect(after.equals(pdfContent)).toBe(true);
  });

  test("does not throw on a regular PDF when password is empty", () => {
    const filePath = join(tmpDir, "regular.pdf");
    writeFileSync(filePath, Buffer.from("%PDF-1.7 some content here"));

    expect(() => tryDecrypt(filePath)).not.toThrow();
  });

  test("does not throw on a non-PDF file when password is empty", () => {
    const filePath = join(tmpDir, "readme.txt");
    writeFileSync(filePath, Buffer.from("just a text file"));

    expect(() => tryDecrypt(filePath)).not.toThrow();
  });

  test("does not throw when file does not exist and password is empty", () => {
    // With empty password, tryDecrypt returns immediately without touching the file
    expect(() => tryDecrypt("/nonexistent/path/file.pdf")).not.toThrow();
  });

  test("with password set: calls qpdf for encrypted file", async () => {
    // Spawn a bun test subprocess with BANK_PDF_PASSWORD set and child_process mocked.
    // The helper is a .test.ts so bun:test mock.module works (it requires bun test runner).
    const helperPath = join(tmpDir, "decrypt-encrypted.test.ts");
    const targetPdf = join(tmpDir, "encrypted.pdf");
    writeFileSync(targetPdf, Buffer.from("%PDF-1.4 encrypted content"));

    const dlHelperPath = DOWNLOAD_HELPER_PATH;
    const pdfPath = JSON.stringify(targetPdf.replace(/\\/g, "/"));
    writeFileSync(helperPath, [
      `import { mock, test, expect } from "bun:test";`,
      ``,
      `const calls: string[][] = [];`,
      `mock.module("child_process", () => ({`,
      `  execSync: (cmd: string, opts?: any) => {`,
      `    calls.push([cmd]);`,
      `    return Buffer.from("");`,
      `  },`,
      `}));`,
      ``,
      `process.env.BANK_PDF_PASSWORD = "secret123";`,
      ``,
      `const { tryDecrypt } = await import("${dlHelperPath}");`,
      ``,
      `test("encrypted", () => {`,
      `  tryDecrypt(${pdfPath});`,
      `  expect(calls.length).toBe(2);`,
      `  expect(calls[0][0]).toInclude("qpdf --is-encrypted");`,
      `  expect(calls[1][0]).toInclude("qpdf --password=");`,
      `  expect(calls[1][0]).toInclude("--decrypt");`,
      `});`,
    ].join("\n"));

    const result = Bun.spawnSync([BUN_EXE, "test", helperPath], {
      cwd: import.meta.dir,
      env: { ...process.env, BANK_PDF_PASSWORD: "secret123" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = result.stderr.toString().trim();
    if (result.exitCode !== 0) {
      throw new Error(`Subprocess test failed (exit ${result.exitCode}):\n${stderr}`);
    }
  });

  test("with password set: skips decrypt for non-encrypted file", async () => {
    const helperPath = join(tmpDir, "decrypt-not-encrypted.test.ts");
    const targetPdf = join(tmpDir, "plain.pdf");
    writeFileSync(targetPdf, Buffer.from("%PDF-1.4 plain content"));

    const dlHelperPath = DOWNLOAD_HELPER_PATH;
    const pdfPath = JSON.stringify(targetPdf.replace(/\\/g, "/"));
    writeFileSync(helperPath, [
      `import { mock, test, expect } from "bun:test";`,
      ``,
      `const calls: string[][] = [];`,
      `mock.module("child_process", () => ({`,
      `  execSync: (cmd: string, opts?: any) => {`,
      `    calls.push([cmd]);`,
      `    if (cmd.includes("--is-encrypted")) {`,
      `      const err: any = new Error("exit code 2");`,
      `      err.status = 2;`,
      `      throw err;`,
      `    }`,
      `    return Buffer.from("");`,
      `  },`,
      `}));`,
      ``,
      `process.env.BANK_PDF_PASSWORD = "secret123";`,
      ``,
      `const { tryDecrypt } = await import("${dlHelperPath}");`,
      ``,
      `test("not-encrypted", () => {`,
      `  tryDecrypt(${pdfPath});`,
      `  // Only qpdf --is-encrypted was called (which threw), no --decrypt call`,
      `  expect(calls.length).toBe(1);`,
      `  expect(calls[0][0]).toInclude("qpdf --is-encrypted");`,
      `});`,
    ].join("\n"));

    const result = Bun.spawnSync([BUN_EXE, "test", helperPath], {
      cwd: import.meta.dir,
      env: { ...process.env, BANK_PDF_PASSWORD: "secret123" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = result.stderr.toString().trim();
    if (result.exitCode !== 0) {
      throw new Error(`Subprocess test failed (exit ${result.exitCode}):\n${stderr}`);
    }
  });
});
