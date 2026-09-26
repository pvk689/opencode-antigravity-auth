import type { Plugin } from "@opencode/plugin";
import { checkForUpdate } from "../hooks/auto-update-checker/checker";
import type { AntigravityConfig } from "../plugin/config";
import { createLogger } from "../plugin/logger";

const log = createLogger("v2-events");

let isChildSession = false;

/**
 * Subscribes to the V2 server event stream.
 *
 * Ported scope (deliberately narrow):
 * - `session.created` tracking so child-session log filtering keeps working.
 * - Startup update check (log-only; V1 showed a TUI toast, which has no V2
 *   Promise-API equivalent, and V2 never auto-updates).
 *
 * Explicitly deferred: the V1 `session.error` thinking-recovery flow. V2 has
 * no `session.error` event in its manifest, and the recovery handler needs
 * `session.messages`/`abort` which the V2 session domain does not expose
 * (`context`/`interrupt` are not drop-in replacements). The in-request
 * thinking-recovery retry (`THINKING_RECOVERY_NEEDED`) IS ported in
 * `src/v2/request.ts` and covers the API-error half of recovery.
 */
export async function registerEventHandlers(
  ctx: Plugin.Context,
  config: AntigravityConfig,
  directory: string,
): Promise<() => void> {
  try {
    const update = await checkForUpdate(directory);
    if (update.needsUpdate && update.latestVersion) {
      log.info("update-available", {
        current: update.currentVersion,
        latest: update.latestVersion,
      });
    }
  } catch (error) {
    log.debug("update-check-failed", { error: String(error) });
  }

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.created") {
            // V2 events carry payloads on `data`; read defensively since only
            // `type` is needed here.
            const data = (event as unknown as { data?: unknown }).data as
              | { info?: { parentID?: unknown }; parentID?: unknown }
              | undefined;
            const parentID = data?.info?.parentID ?? data?.parentID;
            if (typeof parentID === "string" && parentID) {
              isChildSession = true;
              log.debug("child-session-detected", { parentID });
            } else {
              isChildSession = false;
            }
          } else if (config.toast_scope === "root_only" && isChildSession) {
            continue;
          }
        } catch (error) {
          log.debug("event-handler-error", { error: String(error) });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        log.warn("event-subscription-ended", { error: String(error) });
      }
    }
  })();

  return () => controller.abort();
}
