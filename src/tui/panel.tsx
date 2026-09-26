/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "@opentui/solid/jsx-runtime";
import type { Plugin } from "@opencode/plugin/tui";
import { rgbToHex } from "@opentui/core";
import {
  fetchQuotaSnapshot,
  formatReset,
  quotaBar,
  toneFor,
  type QuotaSnapshot,
  type QuotaTone,
} from "./quota";

type TuiContext = Plugin.Context;

const REFRESH_INTERVAL_MS = 120_000;

function toneColor(theme: TuiContext["theme"], tone: QuotaTone): string {
  if (tone === "muted") return rgbToHex(theme.text.muted);
  return rgbToHex(theme.text.feedback[tone].base);
}

function groupRows(snapshotAccount: NonNullable<QuotaSnapshot["accounts"]>[number]): Array<{
  label: string;
  remaining?: number;
  reset?: string;
}> {
  const rows: Array<{ label: string; remaining?: number; reset?: string }> = [];
  const groups = snapshotAccount.quota?.groups;
  if (groups) {
    const entries: Array<[string, typeof groups.claude]> = [
      ["Claude", groups.claude],
      ["Gemini Pro", groups["gemini-pro"]],
      ["Gemini Flash", groups["gemini-flash"]],
    ];
    for (const [label, summary] of entries) {
      if (summary) {
        rows.push({ label, remaining: summary.remainingFraction, reset: summary.resetTime });
      }
    }
  }
  const cliModels = snapshotAccount.geminiCliQuota?.models ?? [];
  for (const model of cliModels.slice(0, 3)) {
    rows.push({
      label: model.modelId,
      remaining: model.remainingFraction,
      reset: model.resetTime,
    });
  }
  if (cliModels.length > 3) {
    rows.push({ label: `…${cliModels.length - 3} more CLI models` });
  }
  return rows;
}

function QuotaPanelView(props: {
  ctx: TuiContext;
  snapshot: QuotaSnapshot | null;
  refreshing: boolean;
}): JSX.Element {
  const theme = props.ctx.theme;
  const base = rgbToHex(theme.text.base);
  const muted = rgbToHex(theme.text.muted);
  const snap = props.snapshot;

  return (
    <box flexDirection="column">
      <text fg={base}>Antigravity Quota{props.refreshing ? " …" : ""}</text>
      <Show
        when={snap}
        fallback={<text fg={muted}>loading…</text>}
      >
        <Show
          when={!snap!.error && snap!.accounts.length > 0}
          fallback={
            <text fg={snap!.error ? theme.text.feedback.error.base : muted}>
              {snap!.error ? `quota error` : "No accounts — opencode auth login"}
            </text>
          }
        >
          <For each={snap!.accounts}>
            {(account) => {
              const dimmed = account.disabled || account.status === "error";
              const title = `${account.email ?? `Account ${account.index + 1}`}${
                account.disabled ? " (disabled)" : ""
              }`;
              return (
                <box flexDirection="column">
                  <text fg={dimmed ? muted : base}>{title}</text>
                  <Show
                    when={account.status !== "error"}
                    fallback={<text fg={theme.text.feedback.error.base}>  ! {account.error}</text>}
                  >
                    <For each={groupRows(account)}>
                      {(row) => (
                        <text fg={dimmed ? muted : toneColor(theme, toneFor(row.remaining))}>
                          {"  "}
                          {row.label.padEnd(14).slice(0, 14)} {quotaBar(row.remaining)}
                          {formatReset(row.reset)}
                        </text>
                      )}
                    </For>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </Show>
    </box>
  );
}

/**
 * Registers the sidebar quota panel, a manual-refresh palette command, and a
 * refresh on every finished session. Returns the setup cleanup.
 */
export function setupQuotaSidebar(ctx: TuiContext): () => void {
  const [snapshot, setSnapshot] = createSignal<QuotaSnapshot | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  let inFlight = false;

  const refresh = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    setRefreshing(true);
    try {
      setSnapshot(await fetchQuotaSnapshot());
    } finally {
      inFlight = false;
      setRefreshing(false);
    }
  };

  const stopIdle = ctx.data.on("session.idle", () => {
    void refresh();
  });

  const render = () => QuotaPanelView({ ctx, snapshot: snapshot(), refreshing: refreshing() });
  const disposeSlot = ctx.ui.slot({ append: "sidebar.content", render });

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "antigravity.quota.refresh",
        title: "Refresh Antigravity quota",
        group: "Antigravity",
        palette: true,
        run: async () => {
          await refresh();
          const count = snapshot()?.accounts.length ?? 0;
          await ctx.ui.toast.show({
            title: "Antigravity",
            message:
              count > 0
                ? `Quota refreshed (${count} account${count === 1 ? "" : "s"})`
                : "No Antigravity accounts",
            variant: "success",
          });
        },
      },
    ],
  }));

  onMount(() => {
    void refresh();
  });

  const timer = setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL_MS);

  onCleanup(() => {
    clearInterval(timer);
    stopIdle();
    disposeSlot();
  });

  return () => {
    clearInterval(timer);
    stopIdle();
    disposeSlot();
  };
}
