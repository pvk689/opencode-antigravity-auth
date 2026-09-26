import type { Plugin } from "@opencode/plugin";
import type { Credential } from "@opencode/schema/credential";
import type { Form } from "@opencode/schema/form";
import { authorizeAntigravity, exchangeAntigravity } from "../antigravity/oauth";
import {
  extractOAuthCallbackParams,
  getStateFromAuthorizationUrl,
  parseOAuthCallbackInput,
  persistAccountPool,
  shouldSkipLocalServer,
} from "../plugin";
import { startOAuthListener } from "../plugin/server";
import type { OAuthAuthDetails } from "../plugin/types";
import { refreshAccessToken } from "../plugin/token";
import { credentialEmail, toOAuthCredential } from "./credential";
import {
  V2_INTEGRATION_ID,
  V2_OAUTH_CALLBACK_TIMEOUT_MS,
  V2_OAUTH_METHOD_ID,
  V2_PROVIDER_ID,
} from "./constants";

const HEADLESS_ENV_VARS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "OPENCODE_HEADLESS"] as const;

function isHeadlessEnvironment(): boolean {
  return HEADLESS_ENV_VARS.some((key) => !!process.env[key]);
}

/**
 * V2 `authorize` for the `antigravity-oauth` method.
 *
 * Mirrors the V1 TUI flow (no `inputs`): returns the Google URL and lets the
 * opencode core drive the browser / manual-code step through the callback.
 * The exchanged account is appended to the on-disk pool (non-destructive)
 * exactly like the V1 TUI callbacks.
 */
export async function authorizeAntigravityV2(_answer: Form.Answer) {
  const manual = isHeadlessEnvironment() || shouldSkipLocalServer();
  const authorization = await authorizeAntigravity("");

  if (!manual) {
    try {
      const listener = await startOAuthListener();
      const state = getStateFromAuthorizationUrl(authorization.url);
      return {
        url: authorization.url,
        instructions:
          "Complete Google sign-in in your browser. The localhost redirect is captured automatically.",
        expiresAt: Date.now() + V2_OAUTH_CALLBACK_TIMEOUT_MS,
        mode: "auto" as const,
        callback: (async (): Promise<Credential.OAuth> => {
          try {
            const callbackUrl = await Promise.race([
              listener.waitForCallback(),
              new Promise<URL>((_resolve, reject) =>
                setTimeout(
                  () => reject(new Error("Timed out waiting for the localhost OAuth callback.")),
                  V2_OAUTH_CALLBACK_TIMEOUT_MS,
                ),
              ),
            ]);
            const params = extractOAuthCallbackParams(callbackUrl);
            if (!params) {
              throw new Error("Missing code or state in the OAuth callback URL.");
            }
            const result = await exchangeAntigravity(params.code, params.state);
            if (result.type === "success") {
              await persistAccountPool([result], false);
            }
            return toOAuthCredential(result);
          } finally {
            await listener.close().catch(() => {});
          }
        })(),
      };
    } catch (error) {
      console.log(
        `[opencode-antigravity-auth] automatic localhost callback unavailable, falling back to manual code entry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const fallbackState = getStateFromAuthorizationUrl(authorization.url);
  return {
    url: authorization.url,
    instructions:
      "Open the URL in your browser, complete Google sign-in, then paste the full redirected localhost URL (or just the code).",
    mode: "code" as const,
    callback: async (codeInput: string): Promise<Credential.OAuth> => {
      const params = parseOAuthCallbackInput(codeInput, fallbackState);
      if ("error" in params) {
        throw new Error(`Invalid OAuth input: ${params.error}`);
      }
      const result = await exchangeAntigravity(params.code, params.state);
      if (result.type === "success") {
        await persistAccountPool([result], false);
      }
      return toOAuthCredential(result);
    },
  };
}

/**
 * V2 `refresh` for credentials minted by this plugin.
 *
 * Reuses the V1 token endpoint logic. The V1 `client` argument is unused by
 * `refreshAccessToken`, so it is omitted here (signature now optional).
 */
export async function refreshAntigravityV2(credential: Credential.OAuth): Promise<Credential.OAuth> {
  const auth: OAuthAuthDetails = {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
  const updated = await refreshAccessToken(auth, null, V2_PROVIDER_ID);
  if (!updated?.access) {
    throw new Error("Antigravity token refresh failed: no access token returned.");
  }
  return {
    type: "oauth",
    methodID: credential.methodID,
    refresh: updated.refresh,
    access: updated.access,
    expires: updated.expires ?? 0,
    metadata: credential.metadata,
  };
}

/** V2 `label` — shows the stored Google account email when available. */
export function labelAntigravityV2(credential: Credential.OAuth): string | undefined {
  return credentialEmail(credential);
}

/**
 * Registers the `antigravity-oauth` method on the builtin `google`
 * integration. Throws when the integration is missing so setup failures
 * stay visible in the plugin status instead of failing silently.
 */
export async function registerAntigravityIntegration(ctx: Plugin.Context): Promise<void> {
  await ctx.integration.transform((editor) => {
    const integration = editor.get(V2_INTEGRATION_ID);
    if (!integration) {
      throw new Error(
        `Integration "${V2_INTEGRATION_ID}" not found; cannot register the Antigravity OAuth method.`,
      );
    }
    editor.method.update({
      integrationID: V2_INTEGRATION_ID,
      method: {
        id: V2_OAUTH_METHOD_ID,
        type: "oauth",
        label: "OAuth with Google (Antigravity)",
      },
      authorize: authorizeAntigravityV2,
      refresh: refreshAntigravityV2,
      label: labelAntigravityV2,
    });
  });
}
