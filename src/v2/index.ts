import { Plugin } from "@opencode/plugin";
import { initV2AccountManager, setV2Config, getV2AccountManager } from "./auth";
import { registerEventHandlers } from "./events";
import { registerAntigravityIntegration } from "./integration";
import { registerAntigravityModels } from "./models";
import { registerRequestHooks } from "./request";
import { registerSearchTool } from "./tool";
import { loadConfig, initRuntimeConfig } from "../plugin/config";
import { initializeDebug } from "../plugin/debug";
import { initDiskSignatureCache } from "../plugin/cache";
import { createProactiveRefreshQueue } from "../plugin/refresh-queue";
import { initHealthTracker, initTokenTracker } from "../plugin/rotation";
import { initAntigravityVersion } from "../plugin/version";
import { V2_PROVIDER_ID } from "./constants";

/**
 * OpenCode v2 (opencode2) entrypoint for opencode-antigravity-auth.
 *
 * V1 plugins do not run in V2 (breaking API change). This module exposes the
 * V2 shape: a default export created with `Plugin.define({ id, setup })`.
 * The V1 implementation in `src/plugin.ts` is intentionally left untouched so
 * the same package keeps working on OpenCode v1.
 *
 * Port status:
 * - Phase 1: scaffold (loads + reports active).
 * - Phase 2: `antigravity-oauth` method on the `google` integration and the
 *   Antigravity model inventory on the `google` provider.
 * - Phase 3: request pipeline (`http.request` rewrite + `http.response`
 *   rotation/quota-fallback/response shaping), `google_search` tool, event
 *   subscription. V1 TUI toasts are routed to the structured logger because
 *   the V2 Promise API exposes no toast channel.
 *
 * Known V2 deviations (documented at each site):
 * - No thinking-warmup pre-request and no background quota refresh (both were
 *   best-effort in V1 and need no client in principle; wiring them to V2
 *   timers is follow-up work).
 * - No proactive token-refresh queue (needs the V1 client).
 * - Session-error recovery flow deferred: V2 has no `session.error` event
 *   and no `session.messages`/`abort` APIs; in-request thinking recovery IS
 *   ported.
 * - Prelude auth failures (refresh/project-context) fail the request instead
 *   of transparently rotating inside one call; the next attempt reselects.
 *   Runtime (post-dispatch) failures rotate transparently like V1.
 */
export default Plugin.define({
  id: "antigravity-auth",
  async setup(ctx) {
    const directory = ctx.location.directory;
    console.log(`[opencode-antigravity-auth] v2 setup (opencode ${ctx.app.version}, dir=${directory})`);

    const config = loadConfig(directory);
    initRuntimeConfig(config);
    setV2Config(config);
    initializeDebug(config);

    await initAntigravityVersion();

    if (config.health_score) {
      initHealthTracker({
        initial: config.health_score.initial,
        successReward: config.health_score.success_reward,
        rateLimitPenalty: config.health_score.rate_limit_penalty,
        failurePenalty: config.health_score.failure_penalty,
        recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
        minUsable: config.health_score.min_usable,
        maxScore: config.health_score.max_score,
      });
    }
    if (config.token_bucket) {
      initTokenTracker({
        maxTokens: config.token_bucket.max_tokens,
        regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
        initialTokens: config.token_bucket.initial_tokens,
      });
    }
    if (config.keep_thinking) {
      initDiskSignatureCache(config.signature_cache);
    }

    await initV2AccountManager(ctx);
    await registerAntigravityIntegration(ctx);
    await registerAntigravityModels(ctx);
    await registerRequestHooks(ctx);
    await registerSearchTool(ctx);
    const disposeEvents = await registerEventHandlers(ctx, config, directory);

    let stopRefreshQueue: (() => void) | undefined;
    if (config.proactive_token_refresh) {
      const refreshQueue = createProactiveRefreshQueue(null, V2_PROVIDER_ID, {
        enabled: config.proactive_token_refresh,
        bufferSeconds: config.proactive_refresh_buffer_seconds,
        checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
      });
      refreshQueue.setAccountManager(getV2AccountManager());
      refreshQueue.start();
      stopRefreshQueue = () => refreshQueue.stop();
    }

    await ctx.storage.set("v2.loaded", {
      version: ctx.app.version,
      loadedAt: new Date().toISOString(),
    });

    return () => {
      stopRefreshQueue?.();
      disposeEvents();
    };
  },
});
