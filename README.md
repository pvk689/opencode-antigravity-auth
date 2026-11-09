# OpenCode Antigravity Auth

Google Antigravity OAuth plugin for **OpenCode v2**. Use eligible Gemini, Claude and other Antigravity models through the Google provider, with account rotation and quota handling.

> OpenCode v1 is not supported. Model availability and quota depend on your Google account and Antigravity access; listing a model does not guarantee access to it.

## Installation

Install OpenCode 2.x and Node.js 20 or newer, then clone and build this repository:

```sh
git clone https://github.com/pvk689/opencode-antigravity-auth.git
cd opencode-antigravity-auth
npm install
npm run build
```

Add the absolute path to the cloned repository to `~/.config/opencode/opencode.json` (or your project’s `opencode.jsonc`), preserving any existing settings and plugins:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-antigravity-auth"]
}
```

Run `opencode reload` if OpenCode is already running. The plugin registers its models automatically; no manual model configuration is required.

## Sign in

```sh
opencode auth login
```

Choose **Google**, then **OAuth with Google (Antigravity)** and complete the browser sign-in. In a headless environment, paste the redirect URL or authorization code when prompted. Additional sign-ins are added to the account pool.

Credentials are sensitive: do not share or commit your OpenCode authentication files or `~/.config/opencode/antigravity-accounts.json`.

## Models and usage

List the models registered with OpenCode:

```sh
opencode models
opencode run --model google/antigravity-gemini-3.8-flash "Explain this repository"
```

The catalog includes Gemini 3.8/3.7 Flash, Gemini 3.1 Pro, Gemini 4 Argon, Claude 4.6 and 5.5, and GPT-OSS model IDs. Availability may vary by account. Use the OpenCode model picker to inspect available variants.

## Quota and accounts

The plugin rotates accounts on rate limits and displays a quota summary in the OpenCode TUI sidebar. Use **Refresh Antigravity quota** in the command palette to refresh it manually. Quota and model access are controlled by Google and can change independently of this plugin.

## Configuration

Optional plugin settings live in `~/.config/opencode/antigravity.json` or `.opencode/antigravity.json` in a project. For example:

```json
{
  "keep_thinking": false,
  "quiet_mode": false
}
```

See [`src/plugin/config/schema.ts`](src/plugin/config/schema.ts) for available settings and defaults. Environment variables override configuration file values.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
