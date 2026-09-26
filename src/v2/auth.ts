import type { Plugin } from "@opencode/plugin";
import type { Credential } from "@opencode/schema/credential";
import { AccountManager } from "../plugin/accounts";
import type { AntigravityConfig } from "../plugin/config";
import type { OAuthAuthDetails } from "../plugin/types";
import { createLogger } from "../plugin/logger";
import { V2_INTEGRATION_ID } from "./constants";

const log = createLogger("v2-auth");

let activeConfig: AntigravityConfig | null = null;
let accountManager: AccountManager | null = null;

export function setV2Config(config: AntigravityConfig): void {
  activeConfig = config;
}

export function getV2Config(): AntigravityConfig {
  if (!activeConfig) {
    throw new Error("Antigravity V2 config not initialized.");
  }
  return activeConfig;
}

export function credentialToAuthDetails(credential: Credential.OAuth): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
}

/**
 * Resolves the active `google` integration credential, if the user connected
 * one (e.g. via the `antigravity-oauth` method from Phase 2).
 */
export async function getConnectionCredential(
  ctx: Plugin.Context,
): Promise<Credential.OAuth | null> {
  try {
    const connection = await ctx.integration.connection.active(V2_INTEGRATION_ID);
    if (!connection) {
      return null;
    }
    const value = await ctx.integration.connection.resolve(connection);
    if (value?.type === "oauth") {
      return value;
    }
    return null;
  } catch (error) {
    log.debug("connection-resolve-failed", { error: String(error) });
    return null;
  }
}

/**
 * Loads the account pool from disk, seeding it with the active connection
 * credential when one exists (mirrors the V1 loader's `getAuth()` fallback).
 * Called on every plugin setup so reloads pick up disk changes.
 */
export async function initV2AccountManager(ctx: Plugin.Context): Promise<AccountManager> {
  const credential = await getConnectionCredential(ctx);
  accountManager = credential
    ? await AccountManager.loadFromDisk(credentialToAuthDetails(credential))
    : await AccountManager.loadFromDisk();
  if (accountManager.getAccountCount() > 0) {
    accountManager.requestSaveToDisk();
  }
  log.debug("account-manager-ready", { accounts: accountManager.getAccountCount() });
  return accountManager;
}

export function getV2AccountManager(): AccountManager {
  if (!accountManager) {
    throw new Error("Antigravity account manager not initialized.");
  }
  return accountManager;
}

/** Test seam (also used on reload): replaces the active account manager. */
export function setV2AccountManager(manager: AccountManager | null): void {
  accountManager = manager;
}
