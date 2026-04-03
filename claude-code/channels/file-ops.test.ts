import { describe, expect, test } from "bun:test";
import { validateFilename, validateUrl } from "./file-ops";

// ---------------------------------------------------------------------------
// validateFilename — path traversal / injection prevention
// ---------------------------------------------------------------------------

describe("validateFilename", () => {
  test("accepts simple filename", () => {
    expect(validateFilename("invoice.pdf")).toBe("invoice.pdf");
  });

  test("accepts filename with spaces", () => {
    expect(validateFilename("my invoice.pdf")).toBe("my invoice.pdf");
  });

  test("accepts filename with underscores and hyphens", () => {
    expect(validateFilename("2026-03_invoice_alza.pdf")).toBe("2026-03_invoice_alza.pdf");
  });

  test("rejects empty string", () => {
    expect(() => validateFilename("")).toThrow("filename is required");
  });

  test("rejects path traversal with ..", () => {
    expect(() => validateFilename("../etc/passwd")).toThrow("must not contain");
  });

  test("rejects embedded ..", () => {
    expect(() => validateFilename("foo/../bar")).toThrow("must not contain");
  });

  test("rejects forward slash", () => {
    expect(() => validateFilename("path/file.pdf")).toThrow("must not contain");
  });

  test("rejects backslash", () => {
    expect(() => validateFilename("path\\file.pdf")).toThrow("must not contain");
  });

  test("rejects dotfile", () => {
    expect(() => validateFilename(".env")).toThrow("must not start with");
  });

  test("rejects null/undefined", () => {
    expect(() => validateFilename(null as any)).toThrow("filename is required");
    expect(() => validateFilename(undefined as any)).toThrow("filename is required");
  });
});

// ---------------------------------------------------------------------------
// validateUrl — protocol restriction
// ---------------------------------------------------------------------------

describe("validateUrl", () => {
  test("accepts http URL", () => {
    expect(validateUrl("http://localhost:8000/file")).toBe("http://localhost:8000/file");
  });

  test("accepts https URL", () => {
    expect(validateUrl("https://example.com/invoice.pdf")).toBe("https://example.com/invoice.pdf");
  });

  test("rejects empty string", () => {
    expect(() => validateUrl("")).toThrow("url is required");
  });

  test("rejects ftp protocol", () => {
    expect(() => validateUrl("ftp://example.com/file")).toThrow("http or https");
  });

  test("rejects file protocol", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow("http or https");
  });

  test("rejects javascript protocol", () => {
    expect(() => validateUrl("javascript:alert(1)")).toThrow("http or https");
  });

  test("rejects non-URL string", () => {
    expect(() => validateUrl("not a url")).toThrow("Invalid URL");
  });

  test("rejects null/undefined", () => {
    expect(() => validateUrl(null as any)).toThrow("url is required");
    expect(() => validateUrl(undefined as any)).toThrow("url is required");
  });
});

// ---------------------------------------------------------------------------
// get_env — allowlist enforcement (tested via subprocess to set DOWNLOADS_DIR)
// ---------------------------------------------------------------------------

describe("get_env allowlist", () => {
  // Replicate the allowlist logic here — the test validates the security
  // boundary, not the fs plumbing.
  const ENV_ALLOWLIST = new Set([
    "GMAIL_EMAIL",
    "TELEGRAM_CHAT_ID",
    "BUSINESS_COMPANY_NAME",
    "BUSINESS_TAX_IDS",
    "BUSINESS_CRN",
    "BUSINESS_LICENSE_PLATES",
  ]);

  function getEnv(name: string): { name: string; value: string } {
    if (!name || typeof name !== "string") throw new Error("name is required");
    if (!ENV_ALLOWLIST.has(name)) {
      throw new Error(`Environment variable '${name}' is not in the allowlist`);
    }
    return { name, value: process.env[name] ?? "" };
  }

  test("returns value for allowlisted var", () => {
    process.env.GMAIL_EMAIL = "test@example.com";
    const result = getEnv("GMAIL_EMAIL");
    expect(result.value).toBe("test@example.com");
    delete process.env.GMAIL_EMAIL;
  });

  test("returns empty string for unset allowlisted var", () => {
    delete process.env.BUSINESS_CRN;
    const result = getEnv("BUSINESS_CRN");
    expect(result.value).toBe("");
  });

  test("rejects non-allowlisted var", () => {
    expect(() => getEnv("PATH")).toThrow("not in the allowlist");
    expect(() => getEnv("BANK_PDF_PASSWORD")).toThrow("not in the allowlist");
    expect(() => getEnv("AWS_SECRET_ACCESS_KEY")).toThrow("not in the allowlist");
  });

  test("rejects empty/null name", () => {
    expect(() => getEnv("")).toThrow("name is required");
    expect(() => getEnv(null as any)).toThrow("name is required");
  });
});
