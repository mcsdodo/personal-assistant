/** Email recipient filter for whitelist/blacklist by TO address. */

export interface FilterableEmail {
  to?: string;
}

/**
 * Filter emails by recipient address.
 * @param include — if non-empty, keep only emails where TO contains this string
 * @param exclude — if non-empty, drop emails where TO contains this string
 */
export function filterEmailsByRecipient<T extends FilterableEmail>(
  emails: T[],
  include: string,
  exclude: string,
): T[] {
  let result = emails;
  if (include) {
    result = result.filter((e) => e.to?.includes(include));
  }
  if (exclude) {
    result = result.filter((e) => !e.to?.includes(exclude));
  }
  return result;
}
