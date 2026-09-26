import { checkAccountsQuota, type AccountQuotaResult } from "../plugin/quota";
import { loadAccounts } from "../plugin/storage";
import { createLogger } from "../plugin/logger";

const log = createLogger("v2-tui-quota");

export interface QuotaSnapshot {
  at: number;
  accounts: AccountQuotaResult[];
  error?: string;
}

export type QuotaTone = "success" | "warning" | "error" | "muted";

/**
 * Reads the on-disk account pool and fetches live quota for every account.
 * Runs in the TUI process (same machine): pure file reads + HTTPS, no server
 * client involved. Failures resolve to an error snapshot, never throw.
 */
export async function fetchQuotaSnapshot(): Promise<QuotaSnapshot> {
  try {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
      return { at: Date.now(), accounts: [] };
    }
    const accounts = await checkAccountsQuota(stored.accounts, null, "google");
    return { at: Date.now(), accounts };
  } catch (error) {
    log.debug("quota-snapshot-failed", { error: String(error) });
    return { at: Date.now(), accounts: [], error: String(error) };
  }
}

export function toneFor(remaining?: number): QuotaTone {
  if (typeof remaining !== "number") return "muted";
  if (remaining < 0.2) return "error";
  if (remaining < 0.6) return "warning";
  return "success";
}

/** Fixed-width text progress bar, e.g. `██████░░░░ 62%`. */
export function quotaBar(remaining?: number, width = 12): string {
  if (typeof remaining !== "number") return `${"░".repeat(width)} ???`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  const pct = `${Math.round(remaining * 100)}%`.padStart(4);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${pct}`;
}

/** Human "resets in …" suffix, empty when unknown or elapsed. */
export function formatReset(resetTime?: string): string {
  if (!resetTime) return "";
  const ms = Date.parse(resetTime) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return ` (resets in ${totalSeconds}s)`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return ` (resets in ${minutes}m)`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return ` (resets in ${days}d ${hours % 24}h)`;
  return ` (resets in ${hours}h ${minutes % 60}m)`;
}
