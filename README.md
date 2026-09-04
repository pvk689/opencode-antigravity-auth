# OpenCode Antigravity Auth

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-pvk689%2Fopencode--antigravity--auth-blue.svg)](https://github.com/pvk689/opencode-antigravity-auth)

Google Antigravity IDE & CLI OAuth authentication plugin for [OpenCode](https://opencode.ai).  
Access **Claude 4.6 (Opus & Sonnet)**, **Gemini 3.8 / 3.7 / 3.1 (Pro & Flash Tiered)**, and **GPT-OSS 120B** using your Google credentials with Antigravity rate limits and multi-account rotation.

---

## 🚀 Key Features

- **Antigravity CLI (`agy`) Synchronization**:
  - Automatically detects and imports existing credentials from `~/.gemini/jetski-standalone-oauth-token` — no browser re-login required.
  - Native Cloud Code PA API backend (`daily-cloudcode-pa.googleapis.com`).
  - Pre-configured User-Agent matching Antigravity Electron to bypass individual consumer `UNSUPPORTED_CLIENT` 400 errors.
- **Next-Gen Model Support**:
  - **Claude Opus 4.6 Thinking** & **Claude Sonnet 4.6** via Google Cloud Code PA.
  - **Gemini 3.8 Flash Tiered**, **Gemini 3.7 Flash Tiered**, and **Gemini 3 Flash** with granular thinking levels (`minimal`, `low`, `medium`, `high`).
  - **Gemini 3.1 Pro** & **Gemini 3 Pro** with thinking levels (`low`, `high`).
  - **GPT-OSS 120B Medium**.
- **Multi-Account Rotation**:
  - Pool multiple Google accounts.
  - Automatically switches accounts when rate limits or quotas are reached.
- **Dual Quota System (Antigravity + Gemini CLI)**:
  - Antigravity quota as primary routing.
  - Fallback to Gemini CLI quota when Antigravity limits are reached (or vice versa with `cli_first`).
- **Thinking Recovery & Signature Handling**:
  - Stable cross-turn thinking block preservation.
  - Automatic tool response grouping and orphan recovery.

---

## 📦 Installation & Setup

### 1. Configure OpenCode

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-antigravity-auth@latest"
  ]
}
```

> **Local Development / Git Installation:**
> If you have cloned or linked this repository locally:
> ```bash
> git clone https://github.com/pvk689/opencode-antigravity-auth.git
> cd opencode-antigravity-auth
> npm install && npm run build
> ```
> Then symlink into your OpenCode plugins cache or `~/.config/opencode/node_modules/opencode-antigravity-auth`.

### 2. Authenticate

Run OpenCode authentication:

```bash
opencode auth login
```

- Select **Google (OAuth)**.
- If you already have an active Antigravity CLI session (`~/.gemini`), OpenCode will prompt to import it instantly:
  ```
  💡 Found existing Antigravity CLI session in ~/.gemini!
  Import existing credentials from Antigravity CLI? (Y/n): Y
  ✓ Successfully imported your account!
  ```
- Or choose **OAuth with Google** to authenticate via browser.
- Select **"Configure models in opencode.json"** from the menu to automatically register all Antigravity models.

### 3. Model Configuration (Manual)

If you prefer to configure models manually, add the following `provider.google` block to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth@latest"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "minimal": { "thinkingLevel": "minimal" },
            "low": { "thinkingLevel": "low" },
            "medium": { "thinkingLevel": "medium" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "minimal": { "thinkingLevel": "minimal" },
            "low": { "thinkingLevel": "low" },
            "medium": { "thinkingLevel": "medium" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "minimal": { "thinkingLevel": "minimal" },
            "low": { "thinkingLevel": "low" },
            "medium": { "thinkingLevel": "medium" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3-pro": {
          "name": "Gemini 3 Pro (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingLevel": "low" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "antigravity-gemini-3.1-pro": {
          "name": "Gemini 3.1 Pro (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingLevel": "low" },
            "high": { "thinkingLevel": "high" }
          }
        },
        "gpt-oss-120b-medium": {
          "name": "GPT-OSS 120B Medium (Antigravity)",
          "limit": { "context": 131072, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] }
        },
        "antigravity-claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "antigravity-claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 Thinking (Antigravity)",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-preview": {
          "name": "Gemini 3 Pro Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3.1-pro-preview": {
          "name": "Gemini 3.1 Pro Preview (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "gemini-3.1-pro-preview-customtools": {
          "name": "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        }
      }
    }
  }
}
```

---

## 🎯 Usage Examples

### Run Gemini 3.8 Flash
```bash
opencode run "Explain quantum computing in simple terms" --model=google/antigravity-gemini-3.8-flash --variant=high
```

### Run Claude Opus 4.6 with Extended Thinking
```bash
opencode run "Architect a scalable microservices system" --model=google/antigravity-claude-opus-4-6-thinking --variant=max
```

### Run GPT-OSS 120B
```bash
opencode run "Write a quick sort algorithm in Rust" --model=google/gpt-oss-120b-medium
```

---

## ⚙️ Advanced Configuration

You can customize plugin behavior by creating `~/.config/opencode/antigravity.json`:

```json
{
  "cli_first": false,
  "keep_thinking": false,
  "session_recovery": true
}
```

| Setting | Default | Description |
|---|---|---|
| `cli_first` | `false` | When `true`, routes Gemini requests to Gemini CLI quota first before falling back to Antigravity. (Claude always uses Antigravity). |
| `keep_thinking` | `false` | Preserves Claude thinking blocks across multiple turns. |
| `session_recovery` | `true` | Automatically recovers from transient session errors and tool failures. |

---

## 👥 Multi-Account Management

Add multiple Google accounts to expand your effective quota:

```bash
opencode auth login
```

The interactive menu lets you:
- **Add account (OAuth browser)**: Add another account via browser flow.
- **Import from Antigravity CLI**: Add account directly from `~/.gemini`.
- **Check quotas**: Inspect remaining limits across all registered accounts.
- **Verify accounts**: Test token validity and refresh state.

Accounts are saved in `~/.config/opencode/antigravity-accounts.json` with rate limit tracking and automated account rotation.

---

## 🛠️ Development & Testing

```bash
# Clone the repository
git clone https://github.com/pvk689/opencode-antigravity-auth.git
cd opencode-antigravity-auth

# Install dependencies
npm install

# Run unit tests
npm test

# Run type checking
npm run typecheck

# Build for production
npm run build
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
