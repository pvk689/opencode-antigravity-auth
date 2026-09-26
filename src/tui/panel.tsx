/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
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
  type QuotaModelItem,
} from "./quota";

type TuiContext = Plugin.Context;

// Refresh every 60s for live, active countdowns matching agy
const REFRESH_INTERVAL_MS = 60_000;

function toneColor(theme: TuiContext["theme"], tone: QuotaTone): string {
  if (tone === "muted") return rgbToHex(theme.text.muted);
  return rgbToHex(theme.text.feedback[tone].base);
}

function QuotaPanelView(props: {
  ctx: TuiContext;
  snapshot: QuotaSnapshot | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  notifyRefreshed: () => Promise<void>;
}): JSX.Element {
  const theme = props.ctx.theme;
  const base = rgbToHex(theme.text.base);
  const muted = rgbToHex(theme.text.muted);

  // Keymap layer inside component scope
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "antigravity.quota.refresh",
        title: "Refresh Antigravity quota",
        group: "Antigravity",
        palette: true,
        run: async () => {
          await props.refresh();
          await props.notifyRefreshed();
        },
      },
    ],
  }));

  const snap = props.snapshot;

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={base}>⚡ Antigravity Quota</text>
        <Show when={props.refreshing}>
          <text fg={muted}>[syncing...]</text>
        </Show>
      </box>

      <Show
        when={snap}
        fallback={<text fg={muted}>  loading quota data...</text>}
      >
        <Show
          when={!snap!.error && snap!.accounts.length > 0}
          fallback={
            <text fg={snap!.error ? theme.text.feedback.error.base : muted}>
              {snap!.error ? `  ! Quota error: ${snap!.error}` : "  No accounts configured"}
            </text>
          }
        >
          <For each={snap!.accounts}>
            {(account) => {
              const dimmed = account.disabled || account.status === "error";
              return (
                <box flexDirection="column" marginTop={1}>
                  <text fg={dimmed ? muted : base}>
                    ● {account.email} {account.disabled ? "(disabled)" : ""}
                  </text>
                  
                  <Show
                    when={account.status !== "error"}
                    fallback={<text fg={theme.text.feedback.error.base}>  ! {account.error}</text>}
                  >
                    {/* Antigravity Quota section */}
                    <Show when={account.antigravityModels.length > 0}>
                      <text fg={muted}>  ┌ Antigravity Models</text>
                      <For each={account.antigravityModels}>
                        {(model: QuotaModelItem, idx) => {
                          const isLast = idx() === account.antigravityModels.length - 1;
                          const connector = isLast ? "  └" : "  ├";
                          const tone = toneFor(model.remainingFraction);
                          return (
                            <text fg={dimmed ? muted : toneColor(theme, tone)}>
                              {connector} {model.name.padEnd(8)} {quotaBar(model.remainingFraction, 10)}
                              {formatReset(model.resetTime)}
                            </text>
                          );
                        }}
                      </For>
                    </Show>

                    {/* Gemini CLI Quota section */}
                    <Show when={account.geminiCliModels.length > 0}>
                      <text fg={muted}>  ┌ Gemini CLI Quota</text>
                      <For each={account.geminiCliModels}>
                        {(model: QuotaModelItem, idx) => {
                          const isLast = idx() === account.geminiCliModels.length - 1;
                          const connector = isLast ? "  └" : "  ├";
                          const tone = toneFor(model.remainingFraction);
                          return (
                            <text fg={dimmed ? muted : toneColor(theme, tone)}>
                              {connector} {model.name.padEnd(24)} {quotaBar(model.remainingFraction, 10)}
                              {formatReset(model.resetTime)}
                            </text>
                          );
                        }}
                      </For>
                    </Show>
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
 * Registers the sidebar quota panel, periodic 60s background refresh,
 * refresh on session.idle, and command palette integration.
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

  const showRefreshToast = async (): Promise<void> => {
    const count = snapshot()?.accounts.length ?? 0;
    await ctx.ui.toast.show({
      title: "Antigravity",
      message:
        count > 0
          ? `Quota updated for ${count} account(s)`
          : "No Antigravity accounts",
      variant: "success",
    });
  };

  const render = () =>
    QuotaPanelView({
      ctx,
      snapshot: snapshot(),
      refreshing: refreshing(),
      refresh,
      notifyRefreshed: showRefreshToast,
    });

  const disposeSlot = ctx.ui.slot({ append: "sidebar.content", render });

  // Initial trigger immediately on startup
  void refresh();

  // Periodic automatic sync every 60s
  const timer = setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    stopIdle();
    disposeSlot();
  };
}
