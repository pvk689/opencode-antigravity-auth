import type { Plugin } from "@opencode/plugin";
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  type HeaderStyle,
} from "../constants";
import {
  AccountManager,
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  parseRateLimitReason,
  type ManagedAccount,
  type ModelFamily,
  type RateLimitReason,
} from "../plugin/accounts";
import { accessTokenExpired } from "../plugin/auth";
import {
  isDebugEnabled,
  logAccountContext,
  logAntigravityDebugResponse,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  startAntigravityDebugRequest,
  type AntigravityDebugContext,
} from "../plugin/debug";
import { EmptyResponseError } from "../plugin/errors";
import {
  createSyntheticErrorResponse,
  isEmptyResponseBody,
} from "../plugin/request-helpers";
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "../plugin/request";
import { checkAccountsQuota } from "../plugin/quota";
import { AntigravityTokenRefreshError, refreshAccessToken } from "../plugin/token";
import { ensureProjectContext } from "../plugin/project";
import { getHealthTracker, getTokenTracker } from "../plugin/rotation";
import type { OAuthAuthDetails, ProjectContextResult } from "../plugin/types";
import {
  FIRST_RETRY_DELAY_MS,
  SWITCH_ACCOUNT_DELAY_MS,
  clearWarmupAttempt,
  extractModelFromUrl,
  extractRetryInfoFromBody,
  extractVerificationErrorDetails,
  formatWaitTime,
  getModelFamilyFromUrl,
  getRateLimitBackoff,
  headerStyleToQuotaKey,
  markWarmupSuccess,
  resetAccountFailureState,
  resetRateLimitState,
  resolveHeaderRoutingDecision,
  resolveQuotaFallbackHeaderStyle,
  retryAfterMsFromResponse,
  sleep,
  toUrlString,
  toWarmupStreamUrl,
  trackAccountFailure,
  trackWarmupAttempt,
} from "../plugin";
import { getV2AccountManager, getV2Config } from "./auth";
import { V2_PROVIDER_ID } from "./constants";
import { createLogger } from "../plugin/logger";

const log = createLogger("v2-request");

let attemptSequence = 0;

interface PreparedSummary {
  streaming: boolean;
  requestedModel?: string;
  projectId?: string;
  endpoint?: string;
  effectiveModel?: string;
  sessionId?: string;
  toolDebugMissing?: number;
  toolDebugSummary?: string;
  toolDebugPayload?: string;
}

interface StoredAttempt {
  id: string;
  sessionID: string;
  modelId: string;
  accountIndex: number;
  headerStyle: HeaderStyle;
  family: ModelFamily;
  model: string | null;
  originalUrl: string;
  originalBody: string | undefined;
  originalMethod: string;
  endpointIndex: number;
  prepared: PreparedSummary;
  /** Debug context of the first (core-dispatched) attempt; further attempts create their own. */
  debugContext: AntigravityDebugContext | null;
  signal: AbortSignal;
}

interface FailureState {
  response: Response;
  streaming: boolean;
  debugContext: AntigravityDebugContext | null;
  requestedModel?: string;
  projectId?: string;
  endpoint?: string;
  effectiveModel?: string;
  sessionId?: string;
  toolDebugMissing?: number;
  toolDebugSummary?: string;
  toolDebugPayload?: string;
}

// Request correlation between the http.request and http.response hooks.
//
// Agy-parity rule: NOTHING extra may go on the wire. In particular no correlation
// header is ever set on the outgoing request (prepare's output is sent byte-identical).
// Correlation is by Request object identity (WeakMap); the bounded recent-list fallback
// only triggers if core ever clones the request between hooks, and every fallback use
// or miss is counted + logged so a leak-free design stays observable.
const attemptsByRequest = new WeakMap<object, StoredAttempt>();
const recentAttempts: StoredAttempt[] = [];
const MAX_STORED_ATTEMPTS = 200;
let correlationFallbackUses = 0;
let correlationMisses = 0;

const emptyResponseAttempts = new Map<string, number>();

let softQuotaNotified = false;
let rateLimitNotified = false;

function resetBlockedNotifications(): void {
  softQuotaNotified = false;
  rateLimitNotified = false;
}

function notify(message: string, variant: "info" | "warning" | "error"): void {
  // V1 showed TUI toasts here; V2 has no toast channel on the Promise API,
  // so route through the structured logger (quiet_mode demotes to debug).
  const quiet = getV2Config().quiet_mode;
  if (quiet) {
    log.debug("notice", { message, variant });
    return;
  }
  if (variant === "warning") log.warn(message);
  else if (variant === "error") log.error(message);
  else log.info(message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}

function storeAttempt(attempt: StoredAttempt, request: Request): void {
  attemptsByRequest.set(request, attempt);
  recentAttempts.push(attempt);
  while (recentAttempts.length > MAX_STORED_ATTEMPTS) {
    recentAttempts.shift();
  }
}

function removeAttempt(id: string): void {
  const index = recentAttempts.findIndex((a) => a.id === id);
  if (index >= 0) {
    recentAttempts.splice(index, 1);
  }
}

function lookupAttempt(request: Request, sessionID: string, modelId: string): StoredAttempt | null {
  const byObject = attemptsByRequest.get(request);
  if (byObject) {
    return byObject;
  }
  for (let i = recentAttempts.length - 1; i >= 0; i--) {
    const candidate = recentAttempts[i];
    if (candidate && candidate.sessionID === sessionID && candidate.modelId === modelId) {
      correlationFallbackUses += 1;
      log.debug("attempt-correlation-fallback", { id: candidate.id, fallbackUses: correlationFallbackUses });
      return candidate;
    }
  }
  correlationMisses += 1;
  log.debug("attempt-correlation-miss", { misses: correlationMisses });
  return null;
}

/**
 * Appends the selected variant to the model id when the driver URL does not
 * already carry a tier suffix. Mirrors the V1 URL shape (`...-high`) that
 * `prepareAntigravityRequest` resolves thinking levels from.
 */
/**
 * V2 uses built-in default variant ids ("default", and "none" on some models)
 * when the user selects no variant. Those are NOT thinking tiers and must never
 * be appended: doing so produced `gemini-3.8-flash-default-tiered`, which Google
 * answers with 429 "Resource exhausted" while the account quota is intact
 * (verified: agy on the same account succeeds at the same time).
 */
const NOOP_VARIANTS = new Set(["default", "none"]);

const TIER_LIKE_SUFFIX_REGEX = /-(minimal|low|medium|high|max|default|none)$/;

export function applyVariantSuffix(urlString: string, urlModel: string | null, variant: string | undefined): string {
  if (!variant || NOOP_VARIANTS.has(variant) || !urlModel || TIER_LIKE_SUFFIX_REGEX.test(urlModel)) {
    return urlString;
  }
  const needle = `/models/${urlModel}`;
  if (!urlString.includes(needle)) {
    return urlString;
  }
  return urlString.split(needle).join(`/models/${urlModel}-${variant}`);
}

async function selectAccount(
  accountManager: AccountManager,
  family: ModelFamily,
  model: string | null,
  preferredHeaderStyle: HeaderStyle,
  allowQuotaFallback: boolean,
  signal: AbortSignal | undefined,
): Promise<{ account: ManagedAccount; headerStyle: HeaderStyle }> {
  const config = getV2Config();
  const accountCount = accountManager.getAccountCount();
  if (accountCount === 0) {
    throw new Error("No Antigravity accounts available. Run `opencode auth login`.");
  }

  const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
    config.soft_quota_cache_ttl_minutes,
    config.quota_refresh_interval_minutes,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(signal);
    let account = accountManager.getCurrentOrNextForFamily(
      family,
      model,
      config.account_selection_strategy,
      preferredHeaderStyle,
      config.pid_offset_enabled,
      config.soft_quota_threshold_percent,
      softQuotaCacheTtlMs,
    );

    let headerStyle = preferredHeaderStyle;
    if (!account && allowQuotaFallback) {
      const alternateHeaderStyle: HeaderStyle =
        preferredHeaderStyle === "antigravity" ? "gemini-cli" : "antigravity";
      account = accountManager.getCurrentOrNextForFamily(
        family,
        model,
        config.account_selection_strategy,
        alternateHeaderStyle,
        config.pid_offset_enabled,
        config.soft_quota_threshold_percent,
        softQuotaCacheTtlMs,
      );
      if (account) {
        headerStyle = alternateHeaderStyle;
      }
    }

    if (account) {
      resetBlockedNotifications();
      return { account, headerStyle };
    }
    if (
      accountManager.areAllAccountsOverSoftQuota(
        family,
        config.soft_quota_threshold_percent,
        softQuotaCacheTtlMs,
        model,
      )
    ) {
      const threshold = config.soft_quota_threshold_percent;
      const softQuotaWaitMs = accountManager.getMinWaitTimeForSoftQuota(
        family,
        threshold,
        softQuotaCacheTtlMs,
        model,
      );
      const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
      if (softQuotaWaitMs === null || (maxWaitMs > 0 && softQuotaWaitMs > maxWaitMs)) {
        const waitTimeFormatted = softQuotaWaitMs ? formatWaitTime(softQuotaWaitMs) : "unknown";
        throw new Error(
          `Quota protection: All ${accountCount} account(s) are over ${threshold}% usage for ${family}. ` +
            `Quota resets in ${waitTimeFormatted}.`,
        );
      }
      if (!softQuotaNotified) {
        notify(
          `All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime(softQuotaWaitMs)}...`,
          "warning",
        );
        softQuotaNotified = true;
      }
      await sleep(softQuotaWaitMs, signal);
      continue;
    }

    const strictWait = !allowQuotaFallback;
    const waitMs =
      accountManager.getMinWaitTimeForFamily(family, model, preferredHeaderStyle, strictWait) || 60_000;
    const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
    if (maxWaitMs > 0 && waitMs > maxWaitMs) {
      throw new Error(
        `All ${accountCount} account(s) rate-limited for ${family}. ` +
          `Quota resets in ${formatWaitTime(waitMs)}.`,
      );
    }
    if (isDebugEnabled()) {
      logAccountContext("All accounts rate-limited", {
        index: -1,
        family,
        totalAccounts: accountCount,
      });
      logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
    }
    if (!rateLimitNotified) {
      notify(
        `All ${accountCount} account(s) rate-limited for ${family}. Waiting ${Math.max(1, Math.ceil(waitMs / 1000))}s...`,
        "warning",
      );
      rateLimitNotified = true;
    }
    await sleep(waitMs, signal);
  }
}

async function ensureAccountAuth(
  accountManager: AccountManager,
  account: ManagedAccount,
  family: ModelFamily,
  model: string | null,
): Promise<{ accessToken: string; projectId: string }> {
  let authRecord = accountManager.toAuthDetails(account);

  if (accessTokenExpired(authRecord)) {
    let refreshed: OAuthAuthDetails | undefined;
    try {
      refreshed = await refreshAccessToken(authRecord, null, V2_PROVIDER_ID);
    } catch (error) {
      if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
        accountManager.removeAccount(account);
        try {
          await accountManager.saveToDisk();
        } catch (persistError) {
          log.error("Failed to persist revoked account removal", { error: String(persistError) });
        }
        if (accountManager.getAccountCount() === 0) {
          throw new Error(
            "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
          );
        }
        throw error;
      }
      const { shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
      getHealthTracker().recordFailure(account.index);
      if (shouldCooldown) {
        accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
        accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!refreshed) {
      const { shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
      getHealthTracker().recordFailure(account.index);
      if (shouldCooldown) {
        accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
        accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
      }
      throw new Error("Antigravity token refresh failed");
    }
    resetAccountFailureState(account.index);
    accountManager.updateFromAuth(account, refreshed);
    authRecord = refreshed;
    try {
      await accountManager.saveToDisk();
    } catch (error) {
      log.error("Failed to persist refreshed auth", { error: String(error) });
    }
  }

  const accessToken = authRecord.access;
  if (!accessToken) {
    throw new Error("Missing access token");
  }

  let projectContext: ProjectContextResult;
  try {
    projectContext = await ensureProjectContext(authRecord);
    resetAccountFailureState(account.index);
  } catch (error) {
    const { shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
    getHealthTracker().recordFailure(account.index);
    if (shouldCooldown) {
      accountManager.markAccountCoolingDown(account, cooldownMs, "project-error");
      accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (
    projectContext.auth.refresh !== authRecord.refresh ||
    projectContext.auth.access !== authRecord.access
  ) {
    accountManager.updateFromAuth(account, projectContext.auth);
    try {
      await accountManager.saveToDisk();
    } catch (error) {
      log.error("Failed to persist project context", { error: String(error) });
    }
  }

  return { accessToken: projectContext.auth.access ?? accessToken, projectId: projectContext.effectiveProjectId };
}

function resolveHeaderStyleForAccount(
  accountManager: AccountManager,
  account: ManagedAccount,
  family: ModelFamily,
  model: string | null,
  preferredHeaderStyle: HeaderStyle,
  allowQuotaFallback: boolean,
): { headerStyle: HeaderStyle; switchAccount: boolean } {
  let headerStyle = preferredHeaderStyle;
  if (!accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle, model)) {
    return { headerStyle, switchAccount: false };
  }

  if (allowQuotaFallback && family === "gemini" && headerStyle === "antigravity") {
    if (accountManager.hasOtherAccountWithAntigravityAvailable(account.index, family, model)) {
      return { headerStyle, switchAccount: true };
    }
    const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
    const fallbackStyle = resolveQuotaFallbackHeaderStyle({ family, headerStyle, alternateStyle });
    if (fallbackStyle) {
      notify("Antigravity quota exhausted on all accounts. Using Gemini CLI quota.", "warning");
      return { headerStyle: fallbackStyle, switchAccount: false };
    }
    return { headerStyle, switchAccount: true };
  }

  if (allowQuotaFallback && family === "gemini") {
    const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
    const fallbackStyle = resolveQuotaFallbackHeaderStyle({ family, headerStyle, alternateStyle });
    if (fallbackStyle) {
      const quotaName = headerStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
      const altQuotaName = fallbackStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
      notify(`${quotaName} quota exhausted, using ${altQuotaName} quota`, "warning");
      return { headerStyle: fallbackStyle, switchAccount: false };
    }
    return { headerStyle, switchAccount: true };
  }

  return { headerStyle, switchAccount: true };
}

export const quotaRefreshInProgress = new Set<string>();

/**
 * Best-effort background quota cache refresh after a successful request.
 * Mirrors V1's triggerAsyncQuotaRefreshForAccount (fire-and-forget, interval
 * gated, deduplicated). The V1 client argument is unnecessary: quota checks
 * only need it for token refresh, whose client parameter is now optional.
 */
function triggerBackgroundQuotaRefresh(
  accountManager: AccountManager,
  accountIndex: number,
): void {
  const config = getV2Config();
  const intervalMinutes = config.quota_refresh_interval_minutes;
  if (!intervalMinutes || intervalMinutes <= 0) {
    return;
  }
  const account = accountManager.getAccounts().find((a) => a.index === accountIndex);
  if (!account || account.enabled === false) {
    return;
  }
  const key = account.email ?? `idx-${accountIndex}`;
  if (quotaRefreshInProgress.has(key)) {
    return;
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  const age =
    account.cachedQuotaUpdatedAt != null ? Date.now() - account.cachedQuotaUpdatedAt : Infinity;
  if (age < intervalMs) {
    return;
  }
  quotaRefreshInProgress.add(key);
  void (async () => {
    try {
      const metas = accountManager.getAccountsForQuotaCheck();
      const meta = metas[accountIndex];
      if (!meta) {
        return;
      }
      const results = await checkAccountsQuota([meta], null, V2_PROVIDER_ID);
      if (results[0]?.status === "ok" && results[0]?.quota?.groups) {
        accountManager.updateQuotaCache(accountIndex, results[0].quota.groups);
        accountManager.requestSaveToDisk();
      }
    } catch (error) {
      log.debug("background-quota-refresh-failed", { key, error: String(error) });
    } finally {
      quotaRefreshInProgress.delete(key);
    }
  })();
}

/**
 * Best-effort thinking-signature warmup for Claude thinking sessions.
 * Mirrors V1's runThinkingWarmup (single attempt per session, failures ignored).
 */
async function runThinkingWarmup(
  prepared: ReturnType<typeof prepareAntigravityRequest>,
  projectId: string,
): Promise<void> {
  if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) {
    return;
  }
  if (!trackWarmupAttempt(prepared.sessionId)) {
    return;
  }
  const warmupBody = buildThinkingWarmupBody(
    typeof prepared.init.body === "string" ? prepared.init.body : undefined,
    Boolean(
      prepared.effectiveModel?.toLowerCase().includes("claude") &&
        prepared.effectiveModel?.toLowerCase().includes("thinking"),
    ),
  );
  if (!warmupBody) {
    return;
  }
  const warmupUrl = toWarmupStreamUrl(prepared.request);
  const warmupHeaders = new Headers(prepared.init.headers ?? {});
  warmupHeaders.set("accept", "text/event-stream");
  const warmupInit: RequestInit = {
    ...prepared.init,
    method: prepared.init.method ?? "POST",
    headers: warmupHeaders,
    body: warmupBody,
  };
  const warmupDebugContext = startAntigravityDebugRequest({
    originalUrl: warmupUrl,
    resolvedUrl: warmupUrl,
    method: warmupInit.method,
    headers: warmupHeaders,
    body: warmupBody,
    streaming: true,
    projectId,
  });
  try {
    log.debug("thinking-warmup-start", { sessionId: prepared.sessionId });
    const warmupResponse = await fetch(warmupUrl, warmupInit);
    const transformed = await transformAntigravityResponse(
      warmupResponse,
      true,
      warmupDebugContext,
      prepared.requestedModel,
      projectId,
      warmupUrl,
      prepared.effectiveModel,
      prepared.sessionId,
    );
    await transformed.text();
    markWarmupSuccess(prepared.sessionId);
    log.debug("thinking-warmup-done", { sessionId: prepared.sessionId });
  } catch (error) {
    clearWarmupAttempt(prepared.sessionId);
    log.debug("thinking-warmup-failed", {
      sessionId: prepared.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleHttpRequest(event: {
  request: Request;
  sessionID: string;
  model: { providerID: string; id: string; variant?: unknown };
}): Promise<void> {
  const urlString = event.request.url;
  if (!isGenerativeLanguageRequest(urlString)) {
    return;
  }

  const config = getV2Config();
  const accountManager = getV2AccountManager();
  const signal = event.request.signal;
  throwIfAborted(signal);

  const family = getModelFamilyFromUrl(urlString);
  const urlModel = extractModelFromUrl(urlString);
  const variant = typeof event.model.variant === "string" ? event.model.variant : undefined;
  let model = urlModel;
  // applyVariantSuffix decides internally (skips built-in default variants and
  // already-suffixed models).
  const effectiveUrl = applyVariantSuffix(urlString, urlModel, variant);
  if (effectiveUrl !== urlString) {
    model = extractModelFromUrl(effectiveUrl);
  }

  const { preferredHeaderStyle, allowQuotaFallback } = resolveHeaderRoutingDecision(
    effectiveUrl,
    family,
    config,
  );

  // V1 parity: the outer loop rotates transparently when prelude auth fails
  // (invalid_grant removals / cooldowns are applied inside ensureAccountAuth,
  // so every retry reselects forward). Bounded to rule out a spin when an
  // account fails without being excluded.
  const maxPreludeAttempts = Math.max(3, accountManager.getAccountCount() * 2 + 1);
  let lastAuthError: unknown = null;
  for (let preludeAttempt = 0; preludeAttempt < maxPreludeAttempts; preludeAttempt++) {
    throwIfAborted(signal);
    const { account, headerStyle: selectedStyle } = await selectAccount(
      accountManager,
      family,
      model,
      preferredHeaderStyle,
      allowQuotaFallback,
      signal,
    );

    if (isDebugEnabled()) {
      logAccountContext("Selected", {
        index: account.index,
        email: account.email,
        family,
        totalAccounts: accountManager.getAccountCount(),
        rateLimitState: account.rateLimitResetTimes,
      });
    }

    const accountCount = accountManager.getAccountCount();
    if (accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
      const accountLabel = account.email || `Account ${account.index + 1}`;
      const enabledAccounts = accountManager.getEnabledAccounts();
      const enabledPosition = enabledAccounts.findIndex((a) => a.index === account.index) + 1;
      notify(`Using ${accountLabel} (${enabledPosition}/${accountCount})`, "info");
      accountManager.markToastShown(account.index);
    }
    accountManager.requestSaveToDisk();

    let finalAccount = account;
    let finalStyle = selectedStyle;
    const resolved = resolveHeaderStyleForAccount(
      accountManager,
      account,
      family,
      model,
      selectedStyle,
      allowQuotaFallback,
    );
    if (resolved.switchAccount) {
      // Mirror V1: retry selection with the account excluded via rate-limit state.
      const reselected = await selectAccount(
        accountManager,
        family,
        model,
        preferredHeaderStyle,
        allowQuotaFallback,
        signal,
      );
      finalAccount = reselected.account;
      finalStyle = reselected.headerStyle;
    }

    let auth: { accessToken: string; projectId: string };
    try {
      auth = await ensureAccountAuth(accountManager, finalAccount, family, model);
    } catch (error) {
      lastAuthError = error;
      continue;
    }

    await handleHttpRequestWithAccount(event, {
      account: finalAccount,
      headerStyle: finalStyle,
      family,
      model,
      effectiveUrl,
      signal,
      accessToken: auth.accessToken,
      projectId: auth.projectId,
    });
    return;
  }

  throw lastAuthError instanceof Error
    ? lastAuthError
    : new Error("Antigravity account authentication failed repeatedly.");
}

async function handleHttpRequestWithAccount(
  event: { request: Request; sessionID: string; model: { providerID: string; id: string } },
  opts: {
    account: ManagedAccount;
    headerStyle: HeaderStyle;
    family: ModelFamily;
    model: string | null;
    effectiveUrl: string;
    signal: AbortSignal;
    accessToken: string;
    projectId: string;
  },
): Promise<void> {
  const config = getV2Config();
  const { account, headerStyle, accessToken, projectId } = opts;
  const { family, model, effectiveUrl, signal } = opts;
  const sessionID = event.sessionID;
  const modelId = String(event.model.id);

  let bodyText: string | undefined;
  try {
    bodyText = await event.request.clone().text();
  } catch {
    bodyText = undefined;
  }

  let endpointIndex = ANTIGRAVITY_ENDPOINT_FALLBACKS.findIndex((endpoint) =>
    headerStyle === "gemini-cli" ? endpoint === ANTIGRAVITY_ENDPOINT_PROD : true,
  );
  if (endpointIndex < 0) endpointIndex = 0;

  const prepared = prepareAntigravityRequest(
    effectiveUrl,
    { method: event.request.method, headers: event.request.headers, body: bodyText },
    accessToken,
    projectId,
    ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex],
    headerStyle,
    false,
    {
      claudeToolHardening: config.claude_tool_hardening,
      claudePromptAutoCaching: config.claude_prompt_auto_caching,
      fingerprint: account.fingerprint,
    },
  );

  if (config.request_jitter_max_ms > 0) {
    const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms);
    if (jitterMs > 0) {
      await sleep(jitterMs, signal);
    }
  }

  const resolvedUrl = toUrlString(prepared.request);
  const debugContext = startAntigravityDebugRequest({
    originalUrl: effectiveUrl,
    resolvedUrl,
    method: prepared.init.method,
    headers: prepared.init.headers,
    body: prepared.init.body,
    streaming: prepared.streaming,
    projectId,
  });

  await runThinkingWarmup(prepared, projectId);

  const id = `ag-${Date.now().toString(36)}-${(attemptSequence += 1).toString(36)}`;
  // NOTE: no correlation header is set here on purpose (agy parity — prepare's
  // headers go on the wire untouched). See lookupAttempt.
  const headers = new Headers(prepared.init.headers);
  const nextRequest = new Request(resolvedUrl, {
    method: prepared.init.method ?? event.request.method,
    headers,
    body: prepared.init.body as BodyInit | undefined,
  });

  storeAttempt(
    {
      id,
      sessionID,
      modelId,
      accountIndex: account.index,
      headerStyle,
      family,
      model,
      originalUrl: effectiveUrl,
      originalBody: bodyText,
      originalMethod: event.request.method,
      endpointIndex,
      prepared: {
        streaming: prepared.streaming,
        requestedModel: prepared.requestedModel,
        projectId: prepared.projectId,
        endpoint: prepared.endpoint,
        effectiveModel: prepared.effectiveModel,
        sessionId: prepared.sessionId,
        toolDebugMissing: prepared.toolDebugMissing,
        toolDebugSummary: prepared.toolDebugSummary,
        toolDebugPayload: prepared.toolDebugPayload,
      },
      debugContext,
      signal,
    },
    nextRequest,
  );

  log.debug("request-dispatched", { url: resolvedUrl, account: account.index, headerStyle });
  event.request = nextRequest;
}

function failureFromAttempt(
  response: Response,
  prepared: PreparedSummary,
  debugContext: AntigravityDebugContext | null,
): FailureState {
  return {
    response,
    streaming: prepared.streaming,
    debugContext,
    requestedModel: prepared.requestedModel,
    projectId: prepared.projectId,
    endpoint: prepared.endpoint,
    effectiveModel: prepared.effectiveModel,
    sessionId: prepared.sessionId,
    toolDebugMissing: prepared.toolDebugMissing,
    toolDebugSummary: prepared.toolDebugSummary,
    toolDebugPayload: prepared.toolDebugPayload,
  };
}

async function transformFailure(failure: FailureState): Promise<Response> {
  return transformAntigravityResponse(
    failure.response,
    failure.streaming,
    failure.debugContext,
    failure.requestedModel,
    failure.projectId,
    failure.endpoint,
    failure.effectiveModel,
    failure.sessionId,
    failure.toolDebugMissing,
    failure.toolDebugSummary,
    failure.toolDebugPayload,
  );
}

async function prepareDirectAttempt(
  stored: StoredAttempt,
  account: ManagedAccount,
  headerStyle: HeaderStyle,
  accessToken: string,
  projectId: string,
  endpoint: string,
  forceThinkingRecovery: boolean,
): Promise<{ url: string; init: RequestInit; prepared: PreparedSummary }> {
  const config = getV2Config();
  const prepared = prepareAntigravityRequest(
    stored.originalUrl,
    { method: stored.originalMethod, body: stored.originalBody },
    accessToken,
    projectId,
    endpoint,
    headerStyle,
    forceThinkingRecovery,
    {
      claudeToolHardening: config.claude_tool_hardening,
      claudePromptAutoCaching: config.claude_prompt_auto_caching,
      fingerprint: account.fingerprint,
    },
  );
  return {
    url: toUrlString(prepared.request),
    init: prepared.init,
    prepared: {
      streaming: prepared.streaming,
      requestedModel: prepared.requestedModel,
      projectId: prepared.projectId,
      endpoint: prepared.endpoint,
      effectiveModel: prepared.effectiveModel,
      sessionId: prepared.sessionId,
      toolDebugMissing: prepared.toolDebugMissing,
      toolDebugSummary: prepared.toolDebugSummary,
      toolDebugPayload: prepared.toolDebugPayload,
    },
  };
}

async function fetchDirect(
  stored: StoredAttempt,
  account: ManagedAccount,
  headerStyle: HeaderStyle,
  endpointIndex: number,
  forceThinkingRecovery: boolean,
): Promise<{
  response: Response;
  prepared: PreparedSummary;
  debugContext: AntigravityDebugContext | null;
}> {
  const accountManager = getV2AccountManager();
  const auth = await ensureAccountAuth(accountManager, account, stored.family, stored.model);
  const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex] ?? ANTIGRAVITY_ENDPOINT_PROD;
  const direct = await prepareDirectAttempt(
    stored,
    account,
    headerStyle,
    auth.accessToken,
    auth.projectId,
    endpoint,
    forceThinkingRecovery,
  );
  const debugContext = startAntigravityDebugRequest({
    originalUrl: stored.originalUrl,
    resolvedUrl: direct.url,
    method: direct.init.method,
    headers: direct.init.headers,
    body: direct.init.body,
    streaming: direct.prepared.streaming,
    projectId: auth.projectId,
  });
  const response = await fetch(direct.url, direct.init);
  return { response, prepared: direct.prepared, debugContext };
}

async function runRotation(stored: StoredAttempt, firstResponse: Response): Promise<Response> {
  const config = getV2Config();
  const accountManager = getV2AccountManager();
  const { family, model, signal } = stored;
  const accountCount = accountManager.getAccountCount();

  let account = accountManager.getAccounts().find((a) => a.index === stored.accountIndex);
  if (!account) {
    const reselected = await selectAccount(
      accountManager,
      family,
      model,
      stored.headerStyle,
      true,
      signal,
    );
    account = reselected.account;
  }
  let headerStyle = stored.headerStyle;
  let endpointIndex = stored.endpointIndex;
  let forceThinkingRecovery = false;
  let capacityRetryCount = 0;
  let lastEndpointIndex = -1;
  let tokenConsumed = false;

  let response: Response | null = firstResponse;
  let prepared: PreparedSummary = stored.prepared;
  let debugContext: AntigravityDebugContext | null = stored.debugContext;
  let lastFailure: FailureState | null = null;
  let lastError: Error | null = null;

  const currentAccount = (): ManagedAccount => {
    const found = accountManager.getAccounts().find((a) => a.index === account!.index);
    if (!found) {
      throw new Error("Antigravity account is no longer available.");
    }
    return found;
  };

  const doFetchDirect = async (): Promise<void> => {
    const active = currentAccount();
    const startIndex = endpointIndex;
    for (;;) {
      const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointIndex] ?? ANTIGRAVITY_ENDPOINT_PROD;
      if (headerStyle !== "gemini-cli" || endpoint === ANTIGRAVITY_ENDPOINT_PROD) {
        break;
      }
      endpointIndex = (endpointIndex + 1) % ANTIGRAVITY_ENDPOINT_FALLBACKS.length;
      if (endpointIndex === startIndex) {
        throw new Error("No usable Antigravity endpoint for Gemini CLI quota.");
      }
    }
    if (endpointIndex !== lastEndpointIndex) {
      capacityRetryCount = 0;
      lastEndpointIndex = endpointIndex;
    }
    if (config.account_selection_strategy === "hybrid" && !tokenConsumed) {
      tokenConsumed = getTokenTracker().consume(active.index);
    }
    try {
      const next = await fetchDirect(stored, active, headerStyle, endpointIndex, forceThinkingRecovery);
      response = next.response;
      prepared = next.prepared;
      debugContext = next.debugContext;
    } catch (error) {
      if (tokenConsumed) {
        getTokenTracker().refund(active.index);
        tokenConsumed = false;
      }
      const { shouldCooldown, cooldownMs } = trackAccountFailure(active.index);
      lastError = error instanceof Error ? error : new Error(String(error));
      if (shouldCooldown) {
        accountManager.markAccountCoolingDown(active, cooldownMs, "network-error");
        accountManager.markRateLimited(active, cooldownMs, family, headerStyle, model);
      }
      // Deviation from V1 (which walks remaining endpoints first): a network
      // error here rotates the account immediately. Bounded and terminating.
      const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
      account = reselected.account;
      headerStyle = reselected.headerStyle;
      endpointIndex = 0;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(signal);

    if (response === null) {
      await doFetchDirect();
      continue;
    }

    const current = response;
    response = null;

    if (current.status === 429 || current.status === 503 || current.status === 529) {
      if (tokenConsumed) {
        getTokenTracker().refund(account!.index);
        tokenConsumed = false;
      }
      const active = currentAccount();
      const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000;
      const headerRetryMs = retryAfterMsFromResponse(current, defaultRetryMs);
      const bodyInfo = await extractRetryInfoFromBody(current);
      const serverRetryMs = bodyInfo.retryDelayMs ?? headerRetryMs;
      const rateLimitReason: RateLimitReason = parseRateLimitReason(
        bodyInfo.reason,
        bodyInfo.message,
        current.status,
      );

      if (rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" || rateLimitReason === "SERVER_ERROR") {
        const baseDelayMs = 1000;
        const maxDelayMs = 8000;
        const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, capacityRetryCount), maxDelayMs);
        const waitMs = Math.round(exponentialDelay * (0.9 + Math.random() * 0.2));
        notify(`Server busy (${current.status}). Retrying in ${Math.round(waitMs / 1000)}s...`, "warning");
        await sleep(waitMs, signal);
        if (capacityRetryCount < 3) {
          capacityRetryCount += 1;
          await doFetchDirect();
          continue;
        }
        const newFingerprint = accountManager.regenerateAccountFingerprint(active.index);
        if (newFingerprint) {
          log.debug("fingerprint-regenerated", { index: active.index });
        }
        endpointIndex += 1;
        if (endpointIndex >= ANTIGRAVITY_ENDPOINT_FALLBACKS.length) {
          endpointIndex = 0;
        }
        continue;
      }

      const quotaKey = headerStyleToQuotaKey(headerStyle, family);
      const { attempt, delayMs } = getRateLimitBackoff(active.index, quotaKey, serverRetryMs);
      const smartBackoffMs = calculateBackoffMs(
        rateLimitReason,
        active.consecutiveFailures ?? 0,
        serverRetryMs,
      );
      // Note: V1 computes max_backoff_seconds here but getRateLimitBackoff
      // applies its own internal cap; effective delay is the max of both.
      const effectiveDelayMs = Math.max(delayMs, smartBackoffMs, 0);

      logRateLimitEvent(active.index, active.email, family, current.status, effectiveDelayMs, bodyInfo);
      await logResponseBody(debugContext, current, current.status);
      getHealthTracker().recordRateLimit(active.index);

      if (attempt === 1 && rateLimitReason !== "QUOTA_EXHAUSTED") {
        notify("Rate limited. Quick retry in 1s...", "warning");
        await sleep(FIRST_RETRY_DELAY_MS, signal);
        if (config.scheduling_mode === "cache_first") {
          const maxCacheFirstWaitMs = config.max_cache_first_wait_seconds * 1000;
          if (effectiveDelayMs <= maxCacheFirstWaitMs) {
            accountManager.markRateLimitedWithReason(
              active,
              family,
              headerStyle,
              model,
              rateLimitReason,
              serverRetryMs,
            );
            await sleep(effectiveDelayMs, signal);
            await doFetchDirect();
            continue;
          }
        }
        if (config.switch_on_first_rate_limit && accountCount > 1) {
          accountManager.markRateLimitedWithReason(
            active,
            family,
            headerStyle,
            model,
            rateLimitReason,
            serverRetryMs,
            config.failure_ttl_seconds * 1000,
          );
          const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
          account = reselected.account;
          headerStyle = reselected.headerStyle;
          endpointIndex = 0;
          continue;
        }
        // Same endpoint retry for the first RPM hit.
        await doFetchDirect();
        continue;
      }

      accountManager.markRateLimitedWithReason(
        active,
        family,
        headerStyle,
        model,
        rateLimitReason,
        serverRetryMs,
        config.failure_ttl_seconds * 1000,
      );
      accountManager.requestSaveToDisk();

      if (family === "gemini") {
        if (headerStyle === "antigravity") {
          if (accountManager.hasOtherAccountWithAntigravityAvailable(active.index, family, model)) {
            notify("Rate limited again. Switching account in 5s...", "warning");
            await sleep(SWITCH_ACCOUNT_DELAY_MS, signal);
            const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
            account = reselected.account;
            headerStyle = reselected.headerStyle;
            endpointIndex = 0;
            continue;
          }
          const alternateStyle = accountManager.getAvailableHeaderStyle(active, family, model);
          const fallbackStyle = resolveQuotaFallbackHeaderStyle({ family, headerStyle, alternateStyle });
          if (fallbackStyle) {
            notify(
              `Antigravity quota exhausted for ${model || "this model"}. Switching to Gemini CLI quota...`,
              "warning",
            );
            headerStyle = fallbackStyle;
            endpointIndex = 0;
            continue;
          }
        } else if (headerStyle === "gemini-cli") {
          const alternateStyle = accountManager.getAvailableHeaderStyle(active, family, model);
          const fallbackStyle = resolveQuotaFallbackHeaderStyle({ family, headerStyle, alternateStyle });
          if (fallbackStyle) {
            notify(
              `Gemini CLI quota exhausted for ${model || "this model"}. Switching to Antigravity quota...`,
              "warning",
            );
            headerStyle = fallbackStyle;
            endpointIndex = 0;
            continue;
          }
        }
      }

      if (accountCount > 1) {
        const quotaMsg = bodyInfo.quotaResetTime ? ` (quota resets ${bodyInfo.quotaResetTime})` : "";
        notify(`Rate limited again. Switching account in 5s...${quotaMsg}`, "warning");
        await sleep(SWITCH_ACCOUNT_DELAY_MS, signal);
      } else {
        const expBackoffMs = Math.min(FIRST_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 60000);
        notify(`Rate limited. Retrying in ${Math.round(expBackoffMs / 1000)}s (attempt ${attempt})...`, "warning");
        await sleep(expBackoffMs, signal);
        await doFetchDirect();
        continue;
      }

      lastFailure = failureFromAttempt(current, prepared, debugContext);
      if (accountCount <= 1) {
        return transformFailure(lastFailure);
      }
      const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
      account = reselected.account;
      headerStyle = reselected.headerStyle;
      endpointIndex = 0;
      continue;
    }

    const quotaKey = headerStyleToQuotaKey(headerStyle, family);
    resetRateLimitState(currentAccount().index, quotaKey);
    resetAccountFailureState(currentAccount().index);

    if (current.status === 403) {
      const errorBodyText = await current.clone().text().catch(() => "");
      const extracted = extractVerificationErrorDetails(errorBodyText);
      // Permanent license/subscription denials (e.g. SUBSCRIPTION_REQUIRED for a
      // model the account may not use) must NOT spin the endpoint loop: every
      // endpoint shares the account's license state, so retries are pure
      // hammering (account-ban risk). Lock only this model+quota key and fail
      // fast. Deliberate deviation from V1, which retried all 403s per endpoint.
      const licenseDenied =
        !extracted.validationRequired &&
        /subscri|license|permission_denied/i.test(
          `${extracted.message ?? ""} ${errorBodyText.slice(0, 500)}`,
        );
      if (licenseDenied) {
        const active = currentAccount();
        const cooldownMs = 10 * 60 * 1000;
        // Model-scoped lock only (no account-wide cooldown/disable): other
        // models on this account stay usable.
        accountManager.markRateLimited(active, cooldownMs, family, headerStyle, model);
        accountManager.requestSaveToDisk();
        getHealthTracker().recordFailure(active.index);
        log.warn("license-denied", {
          index: active.index,
          model,
          message: extracted.message,
        });
        lastFailure = failureFromAttempt(current, prepared, debugContext);
        if (accountCount <= 1) {
          return transformFailure(lastFailure);
        }
        const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
        account = reselected.account;
        headerStyle = reselected.headerStyle;
        endpointIndex = 0;
        continue;
      }
      if (extracted.validationRequired) {
        const active = currentAccount();
        const verificationReason = extracted.message ?? "Google requires account verification.";
        const cooldownMs = 10 * 60 * 1000;
        accountManager.markAccountVerificationRequired(active.index, verificationReason, extracted.verifyUrl);
        accountManager.markAccountCoolingDown(active, cooldownMs, "validation-required");
        accountManager.markRateLimited(active, cooldownMs, family, headerStyle, model);
        const label = active.email || `Account ${active.index + 1}`;
        if (accountManager.shouldShowAccountToast(active.index, 60000)) {
          notify(`${label} needs verification. Run 'opencode auth login' and use Verify accounts.`, "warning");
          accountManager.markToastShown(active.index);
        }
        getHealthTracker().recordFailure(active.index);
        lastFailure = failureFromAttempt(current, prepared, debugContext);
        if (accountCount <= 1) {
          return transformFailure(lastFailure);
        }
        const reselected = await selectAccount(accountManager, family, model, headerStyle, true, signal);
        account = reselected.account;
        headerStyle = reselected.headerStyle;
        endpointIndex = 0;
        continue;
      }
    }

    const shouldRetryEndpoint =
      current.status === 403 || current.status === 404 || current.status >= 500;
    if (shouldRetryEndpoint && endpointIndex < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
      await logResponseBody(debugContext, current, current.status);
      lastFailure = failureFromAttempt(current, prepared, debugContext);
      endpointIndex += 1;
      continue;
    }

    if (current.ok) {
      const active = currentAccount();
      active.consecutiveFailures = 0;
      getHealthTracker().recordSuccess(active.index);
      accountManager.markAccountUsed(active.index);
      triggerBackgroundQuotaRefresh(accountManager, active.index);
    }

    logAntigravityDebugResponse(debugContext, current, {
      note: current.ok ? "Success" : `Error ${current.status}`,
    });
    if (!current.ok || !prepared.streaming) {
      await logResponseBody(debugContext, current, current.status);
    }

    if (!current.ok && current.status === 400) {
      const bodyText = await current.clone().text().catch(() => "");
      if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
        notify("Context too long - use /compact to reduce size", "warning");
        return createSyntheticErrorResponse(
          "[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.",
          prepared.requestedModel,
        );
      }
    }

    // Empty response retry (V1: only for ok + non-streaming responses).
    if (current.ok && !prepared.streaming) {
      const maxAttempts = config.empty_response_max_attempts ?? 4;
      const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000;
      const bodyText = await current.clone().text().catch(() => "");
      if (isEmptyResponseBody(bodyText)) {
        const emptyAttemptKey = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
        const currentAttempts = (emptyResponseAttempts.get(emptyAttemptKey) ?? 0) + 1;
        emptyResponseAttempts.set(emptyAttemptKey, currentAttempts);
        if (currentAttempts < maxAttempts) {
          notify(`Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`, "warning");
          await sleep(retryDelayMs, signal);
          await doFetchDirect();
          continue;
        }
        emptyResponseAttempts.delete(emptyAttemptKey);
        throw new EmptyResponseError("antigravity", prepared.effectiveModel ?? "unknown", currentAttempts);
      }
      emptyResponseAttempts.delete(`${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`);
    }

    let transformed: Response;
    try {
      transformed = await transformAntigravityResponse(
        current,
        prepared.streaming,
        debugContext,
        prepared.requestedModel,
        prepared.projectId,
        prepared.endpoint,
        prepared.effectiveModel,
        prepared.sessionId,
        prepared.toolDebugMissing,
        prepared.toolDebugSummary,
        prepared.toolDebugPayload,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
        if (!forceThinkingRecovery) {
          forceThinkingRecovery = true;
          endpointIndex = 0;
          continue;
        }
        const recoveryError = error as { originalError?: { error?: { message?: string } } };
        const originalMessage =
          recoveryError.originalError?.error?.message || "Session recovery failed";
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "unrecoverable_error",
              message: `${originalMessage}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`,
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      throw error;
    }

    const contextError = transformed.headers.get("x-antigravity-context-error");
    if (contextError === "prompt_too_long") {
      notify("Context too long - use /compact to reduce size, or trim your request", "warning");
    } else if (contextError === "tool_pairing") {
      notify("Tool call/result mismatch - use /compact to fix, or /undo last message", "warning");
    }
    return transformed;
  }
}

export async function handleHttpResponse(event: {
  request: Request;
  response: Response;
  sessionID: string;
  model: { providerID: string; id: string };
}): Promise<void> {
  const stored = lookupAttempt(event.request, event.sessionID, String(event.model.id));
  if (!stored) {
    return;
  }
  removeAttempt(stored.id);
  try {
    event.response = await runRotation(stored, event.response);
  } catch (error) {
    removeAttempt(stored.id);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Registers the Antigravity request pipeline on the `google` provider:
 * `http.request` rewrites the outgoing call to the Antigravity backend and
 * `http.response` applies rotation, quota fallback and response shaping.
 */
export async function registerRequestHooks(ctx: Plugin.Context): Promise<void> {
  await ctx.session.hook(
    "http.request",
    async (event) => {
      await handleHttpRequest(event);
    },
    { providerID: V2_PROVIDER_ID },
  );
  await ctx.session.hook(
    "http.response",
    async (event) => {
      await handleHttpResponse(event);
    },
    { providerID: V2_PROVIDER_ID },
  );
}
