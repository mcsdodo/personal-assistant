/**
 * Regression-lock test for task 97 (decouple business-owner label).
 *
 * Guards two invariants that must never silently regress:
 * 1. The owner-role enum values are "business" / "personal" / "unknown" —
 *    "techlab" must not appear as an owner role in OWNERS or DOC_OWNERS.
 * 2. requireBusinessLabel() throws when OWNER_BUSINESS_LABEL is unset/empty
 *    and returns the value when set — no silent fallback to any hard-coded default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OWNERS, DOC_OWNERS } from "./workflow-schemas";
import { requireBusinessLabel } from "./invoice/pipeline";

describe("task-97 regression lock — owner role enums", () => {
  test('OWNERS does not contain "techlab"', () => {
    expect(Array.from(OWNERS)).not.toContain("techlab");
  });

  test('OWNERS contains "business"', () => {
    expect(Array.from(OWNERS)).toContain("business");
  });

  test('DOC_OWNERS does not contain "techlab"', () => {
    expect(Array.from(DOC_OWNERS)).not.toContain("techlab");
  });

  test('DOC_OWNERS contains "business"', () => {
    expect(Array.from(DOC_OWNERS)).toContain("business");
  });
});

describe("task-96label regression lock — requireBusinessLabel", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OWNER_BUSINESS_LABEL;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OWNER_BUSINESS_LABEL;
    } else {
      process.env.OWNER_BUSINESS_LABEL = saved;
    }
  });

  test("throws when OWNER_BUSINESS_LABEL is unset", () => {
    delete process.env.OWNER_BUSINESS_LABEL;
    expect(() => requireBusinessLabel()).toThrow("OWNER_BUSINESS_LABEL must be set");
  });

  test("throws when OWNER_BUSINESS_LABEL is empty string", () => {
    process.env.OWNER_BUSINESS_LABEL = "";
    expect(() => requireBusinessLabel()).toThrow("OWNER_BUSINESS_LABEL must be set");
  });

  test("throws when OWNER_BUSINESS_LABEL is whitespace only", () => {
    process.env.OWNER_BUSINESS_LABEL = "   ";
    expect(() => requireBusinessLabel()).toThrow("OWNER_BUSINESS_LABEL must be set");
  });

  test("returns the value when OWNER_BUSINESS_LABEL is set", () => {
    process.env.OWNER_BUSINESS_LABEL = "techlab";
    expect(requireBusinessLabel()).toBe("techlab");
  });

  test("returns the value when OWNER_BUSINESS_LABEL is a custom label", () => {
    process.env.OWNER_BUSINESS_LABEL = "acme";
    expect(requireBusinessLabel()).toBe("acme");
  });
});
