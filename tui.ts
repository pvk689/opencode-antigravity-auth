import { Plugin } from "@opencode/plugin/tui";
import { setupQuotaSidebar } from "./src/tui/panel";

/**
 * OpenCode v2 CLI (TUI) entrypoint for opencode-antigravity-auth.
 *
 * Loaded by the terminal UI (not the background server). Registers the
 * Antigravity quota tracker in the sidebar plus a manual-refresh command.
 * Quota data is read from the same on-disk account pool the server plugin
 * maintains, so both sides always agree.
 */
export default Plugin.define({
  id: "antigravity.quota",
  async setup(ctx) {
    return setupQuotaSidebar(ctx);
  },
});
