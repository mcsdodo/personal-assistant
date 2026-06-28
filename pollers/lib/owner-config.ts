/**
 * Owner-label config for the pollers workspace.
 *
 * The pollers are a separate bun workspace and CANNOT import from
 * `claude-code/` (no shared module path). This function is therefore a
 * deliberate TWIN of `requireBusinessLabel` in
 * `claude-code/channels/invoice/pipeline.ts` — identical semantics, mirroring
 * the schema-twin duplication pattern. Keep the two in sync.
 *
 * The gdrive-poller maps the Drive owner-folder name → owner role: the folder
 * whose name equals `OWNER_BUSINESS_LABEL` → role "business";
 * a folder named "personal" → role "personal".
 * Throws a clear error if OWNER_BUSINESS_LABEL is unset or empty.
 */
export function requireBusinessLabel(): string {
  const v = process.env.OWNER_BUSINESS_LABEL?.trim();
  if (!v) throw new Error(
    "OWNER_BUSINESS_LABEL must be set (configure it in komodo.toml / .env)");
  return v;
}
