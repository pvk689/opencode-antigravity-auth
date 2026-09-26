import type { Plugin } from "@opencode/plugin";
import { accessTokenExpired, parseRefreshParts } from "../plugin/auth";
import { createLogger } from "../plugin/logger";
import { executeSearch } from "../plugin/search";
import { refreshAccessToken } from "../plugin/token";
import type { OAuthAuthDetails } from "../plugin/types";
import { credentialToAuthDetails, getConnectionCredential } from "./auth";
import { V2_PROVIDER_ID } from "./constants";

const log = createLogger("v2-tool");

const GOOGLE_SEARCH_DESCRIPTION =
  "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. " +
  "Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. " +
  "You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST " +
  "extract those URLs and pass them in the 'urls' parameter for direct analysis.";

/**
 * Registers the `google_search` tool (V2 equivalent of the V1 `tool` map
 * entry). Credentials come from the active `google` integration connection;
 * the access token is refreshed on demand exactly like the V1 executor.
 */
export async function registerSearchTool(ctx: Plugin.Context): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "google_search",
      description: GOOGLE_SEARCH_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query or question to answer using web search",
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description:
              "List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here.",
          },
          thinking: {
            type: "boolean",
            description: "Enable deep thinking for more thorough analysis (default: true)",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const args = input as { query: string; urls?: string[]; thinking?: boolean };
        log.debug("google-search-called", { query: args.query, urlCount: args.urls?.length ?? 0 });

        const credential = await getConnectionCredential(ctx);
        if (!credential) {
          return {
            content: "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.",
          };
        }

        let auth: OAuthAuthDetails = credentialToAuthDetails(credential);
        if (accessTokenExpired(auth)) {
          const refreshed = await refreshAccessToken(auth, null, V2_PROVIDER_ID).catch(() => undefined);
          if (!refreshed?.access) {
            return { content: "Error: Failed to refresh access token. Please re-authenticate." };
          }
          auth = refreshed;
        }
        if (!auth.access) {
          return { content: "Error: No valid access token available. Please re-authenticate." };
        }

        const parts = parseRefreshParts(auth.refresh);
        const projectId = parts.managedProjectId || parts.projectId || "unknown";
        try {
          const result = await executeSearch(
            { query: args.query, urls: args.urls, thinking: args.thinking ?? true },
            auth.access,
            projectId,
            context.signal,
          );
          return { content: result };
        } catch (error) {
          log.error("google-search-failed", { error: String(error) });
          return { content: `Error: Google Search failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    });
  });
}
