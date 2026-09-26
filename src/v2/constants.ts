/**
 * Shared V2 constants. Kept dependency-free so unit tests can import V2
 * modules without pulling the V1 implementation (`src/plugin.ts`, which
 * depends on `@opencode-ai/plugin` and only resolves under Bun).
 */

/** Integration + provider IDs reused from V1 so `google/antigravity-...` refs keep working. */
export const V2_INTEGRATION_ID = "google";
export const V2_PROVIDER_ID = "google";

/** Method ID of the OAuth method registered on the `google` integration. */
export const V2_OAUTH_METHOD_ID = "antigravity-oauth";

/** Matches the V1 TUI auto-callback race (CALLBACK_TIMEOUT_MS in src/plugin.ts). */
export const V2_OAUTH_CALLBACK_TIMEOUT_MS = 30_000;
