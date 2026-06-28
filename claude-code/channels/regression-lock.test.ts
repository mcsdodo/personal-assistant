/**
 * Regression-lock test for task 97 (decouple business-owner label).
 *
 * Guards two invariants that must never silently regress:
 * 1. The owner-role enum values are "business" / "personal" / "unknown" —
 *    "techlab" must not appear as an owner role in OWNERS or DOC_OWNERS.
 * 2. The default for OWNER_BUSINESS_LABEL resolution is "techlab" —
 *    changing this would silently re-tag all future business documents
 *    with a new value and orphan existing Paperless docs tagged "techlab".
 */

import { describe, expect, test } from "bun:test";

import { OWNERS, DOC_OWNERS } from "./workflow-schemas";
import { DEFAULT_OWNER_BUSINESS_LABEL } from "./invoice/pipeline";

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

describe("task-97 regression lock — DEFAULT_OWNER_BUSINESS_LABEL", () => {
  test('DEFAULT_OWNER_BUSINESS_LABEL is "techlab"', () => {
    // Changing this default would silently re-tag all future business
    // documents and orphan existing Paperless docs tagged "techlab".
    // If you intend to change the default, update this test intentionally.
    expect(DEFAULT_OWNER_BUSINESS_LABEL).toBe("techlab");
  });
});
