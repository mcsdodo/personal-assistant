/**
 * Owner-label config for the pollers workspace.
 *
 * The pollers are a separate bun workspace and CANNOT import from
 * `claude-code/` (no shared module path). This constant is therefore a
 * deliberate DUPLICATE of `DEFAULT_OWNER_BUSINESS_LABEL` in
 * `claude-code/channels/invoice/pipeline.ts` — same value, mirroring the
 * schema-twin duplication pattern. Keep the two in sync.
 *
 * The gdrive-poller maps the Drive owner-folder name → owner role: the folder
 * whose name equals `OWNER_BUSINESS_LABEL` (default below) → role "business";
 * a folder named "personal" → role "personal".
 */
export const DEFAULT_OWNER_BUSINESS_LABEL = "techlab";
