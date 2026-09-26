import type { Credential } from "@opencode/schema/credential";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { V2_OAUTH_METHOD_ID } from "./constants";

/**
 * Converts a V1 token exchange result into a V2 OAuth credential.
 *
 * V2 callbacks resolve `Promise<Credential.OAuth>` (no failed union), so
 * exchange failures are surfaced as thrown errors instead of
 * `{ type: "failed" }` results.
 */
export function toOAuthCredential(
  result: AntigravityTokenExchangeResult,
  methodID: string = V2_OAUTH_METHOD_ID,
): Credential.OAuth {
  if (result.type !== "success") {
    throw new Error(`Antigravity authentication failed: ${result.error}`);
  }
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: {
      email: result.email,
      projectId: result.projectId,
    },
  };
}

/** Reads the account email stored on a credential minted by this plugin. */
export function credentialEmail(credential: Credential.OAuth): string | undefined {
  const metadata = credential.metadata as { email?: unknown } | undefined;
  return typeof metadata?.email === "string" && metadata.email ? metadata.email : undefined;
}
