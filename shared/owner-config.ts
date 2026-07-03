/**
 * Owner-label config — single source of truth for the OWNER_BUSINESS_LABEL
 * contract (task 97), shared by claude-code/channels and pollers via barrels.
 *
 * The gdrive-poller maps the Drive owner-folder name → owner role: the folder
 * whose name equals `OWNER_BUSINESS_LABEL` → role "business";
 * a folder named "personal" → role "personal".
 *
 * OWNER_BUSINESS_LABEL is REQUIRED — there is deliberately no code default,
 * so a misconfigured deployment fails loud at use-time rather than silently
 * falling back to a hard-coded company name.
 *
 * shared/ is dependency-free by design — do not add npm imports here.
 */
export function requireBusinessLabel(): string {
  const v = process.env.OWNER_BUSINESS_LABEL?.trim();
  if (!v) throw new Error(
    "OWNER_BUSINESS_LABEL must be set (configure it in komodo.toml / .env)");
  return v;
}
