import { checkAccountsQuota, type AccountQuotaResult } from "../plugin/quota";
import { loadAccounts, saveAccounts } from "../plugin/storage";
import { createLogger } from "../plugin/logger";

const log = createLogger("v2-tui-quota");

export interface QuotaModelItem {
  name: string;
  remainingFraction: number;
  resetTime?: string;
}

export interface AccountQuotaItem {
  index: number;
  email: string;
  disabled: boolean;
  status: "ok" | "disabled" | "error";
  error?: string;
  antigravityModels: QuotaModelItem[];
  geminiCliModels: QuotaModelItem[];
}

export interface QuotaSnapshot {
  at: number;
  accounts: AccountQuotaItem[];
  error?: string;
}

export type QuotaTone = "success" | "warning" | "error" | "muted";

/**
 * Filter and format models exactly like agy / Antigravity CLI does:
 * - Claude Opus 4.6 Thinking
 * - Claude Sonnet 4.6
 * - Gemini 3.8 Flash (Tiered)
 * - Gemini 3.7 Flash (Tiered)
 * - Gemini 3.1 Pro (High / Low)
 * - GPT-OSS 120B
 * Or group summaries if detailed entries aren't directly available.
 */
export async function fetchQuotaSnapshot(): Promise<QuotaSnapshot> {
  try {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
      return { at: Date.now(), accounts: [] };
    }

    const results = await checkAccountsQuota(stored.accounts, null, "google");
    
    // Also save updated tokens/cache if any account refreshed during quota check
    let storageChanged = false;
    for (const res of results) {
      if (res.updatedAccount) {
        stored.accounts[res.index] = {
          ...stored.accounts[res.index],
          ...res.updatedAccount,
        };
        storageChanged = true;
      }
    }
    if (storageChanged) {
      await saveAccounts(stored).catch(() => {});
    }

    const accountItems: AccountQuotaItem[] = results.map((res) => {
      const agModels: QuotaModelItem[] = [];
      const cliModels: QuotaModelItem[] = [];

      // Extract Antigravity quota models (same clean names as agy)
      if (res.quota?.groups) {
        const groups = res.quota.groups;
        if (groups.claude) {
          agModels.push({
            name: "Claude 4.6 (Sonnet/Opus)",
            remainingFraction: groups.claude.remainingFraction ?? 1,
            resetTime: groups.claude.resetTime,
          });
        }
        if (groups["gemini-pro"]) {
          agModels.push({
            name: "Gemini 3 Pro / 3.1 Pro",
            remainingFraction: groups["gemini-pro"].remainingFraction ?? 1,
            resetTime: groups["gemini-pro"].resetTime,
          });
        }
        if (groups["gemini-flash"]) {
          agModels.push({
            name: "Gemini 3 Flash (3.8/3.7)",
            remainingFraction: groups["gemini-flash"].remainingFraction ?? 1,
            resetTime: groups["gemini-flash"].resetTime,
          });
        }
      }

      // Gemini CLI Quota
      if (res.geminiCliQuota?.models) {
        for (const m of res.geminiCliQuota.models) {
          cliModels.push({
            name: m.modelId,
            remainingFraction: m.remainingFraction,
            resetTime: m.resetTime,
          });
        }
      }

      return {
        index: res.index,
        email: res.email || `Account ${res.index + 1}`,
        disabled: !!res.disabled,
        status: res.status,
        error: res.error,
        antigravityModels: agModels,
        geminiCliModels: cliModels,
      };
    });

    return { at: Date.now(), accounts: accountItems };
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

/** Progress bar matching agy CLI: ████████░░ 80% */
export function quotaBar(remaining?: number, width = 10): string {
  if (typeof remaining !== "number") return `${"░".repeat(width)} ???`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  const pct = `${Math.round(remaining * 100)}%`.padStart(4);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${pct}`;
}

/** Human "resets in …" suffix, format matching agy CLI */
export function formatReset(resetTime?: string): string {
  if (!resetTime) return "";
  const parsed = Date.parse(resetTime);
  if (!Number.isFinite(parsed)) return "";
  const ms = parsed - Date.now();
  if (ms <= 0) return " (resetting...)";
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return ` (resets in ${totalSeconds}s)`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const s = totalSeconds % 60;
    return s > 0 ? ` (resets in ${minutes}m ${s}s)` : ` (resets in ${minutes}m)`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? ` (resets in ${hours}h ${remainingMinutes}m)` : ` (resets in ${hours}h)`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return ` (resets in ${days}d ${remainingHours}h)`;
}
