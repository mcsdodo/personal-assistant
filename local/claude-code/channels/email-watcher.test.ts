import { describe, test, expect } from "bun:test";
import { filterEmailsByRecipient } from "./email-filter";

// Minimal EmailInfo-like objects for testing the filter
function email(to?: string) {
  return { id: `msg-${Math.random()}`, source: "gmail" as const, to };
}

describe("filterEmailsByRecipient", () => {
  test("returns all emails when no filters set", () => {
    const emails = [email("user@gmail.com"), email("user+dev@gmail.com")];
    const result = filterEmailsByRecipient(emails, "", "");
    expect(result).toHaveLength(2);
  });

  test("include filter keeps only matching recipients", () => {
    const emails = [
      email("user@gmail.com"),
      email("user+dev@gmail.com"),
      email("user+dev@gmail.com"),
      email("other@outlook.com"),
    ];
    const result = filterEmailsByRecipient(emails, "+dev", "");
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.to?.includes("+dev"))).toBe(true);
  });

  test("exclude filter removes matching recipients", () => {
    const emails = [
      email("user@gmail.com"),
      email("user+dev@gmail.com"),
      email("other@outlook.com"),
    ];
    const result = filterEmailsByRecipient(emails, "", "+dev");
    expect(result).toHaveLength(2);
    expect(result.every((e) => !e.to?.includes("+dev"))).toBe(true);
  });

  test("include filter drops emails with no TO field", () => {
    const emails = [email(undefined), email("user+dev@gmail.com")];
    const result = filterEmailsByRecipient(emails, "+dev", "");
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("user+dev@gmail.com");
  });

  test("exclude filter keeps emails with no TO field", () => {
    const emails = [email(undefined), email("user+dev@gmail.com")];
    const result = filterEmailsByRecipient(emails, "", "+dev");
    expect(result).toHaveLength(1);
    expect(result[0].to).toBeUndefined();
  });

  test("both include and exclude can be combined", () => {
    const emails = [
      email("user+dev@gmail.com"),
      email("user+dev+test@gmail.com"),
      email("user@gmail.com"),
    ];
    // include +dev, exclude +test
    const result = filterEmailsByRecipient(emails, "+dev", "+test");
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("user+dev@gmail.com");
  });

  test("returns empty array when include matches nothing", () => {
    const emails = [email("user@gmail.com"), email("other@outlook.com")];
    const result = filterEmailsByRecipient(emails, "+dev", "");
    expect(result).toHaveLength(0);
  });
});
