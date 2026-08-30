# LLMStatus

LLMStatus is a local desktop app for macOS and Windows that shows official coding CLI usage limits in one screen.

LLMStatus is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI or Anthropic.

Register one or more Codex and Claude Code profiles in one local dashboard. Existing settings that contain distinct advanced profile paths remain compatible. The primary value is the used percentage supplied by each CLI; remaining percentage is explicitly calculated as `100 - used`. LLMStatus does not guess an exact remaining token count that a provider does not publish.

> [!IMPORTANT]
> v0.2.0 is available as an unsigned source release. Build locally using the instructions below.

## Features

- Registration with only a display name and adapter; provider profile selection is optional
- Automatic internal account IDs and Codex CLI discovery from `PATH`
- Per-account resolved-profile labels and validated import of existing profile directories
- Official Codex CLI `app-server` over stdio JSON-RPC
- Only allowlisted usage percentages and reset times from the official Claude Code `statusLine`
- One-click Claude usage refresh for profiles with missing or expired usage data
- Distinct live, stale, unavailable, and error states
- Menu bar and system tray presence
- No cloud sync, telemetry, browser-cookie access, or API-key storage
- Tauri configuration with no arbitrary shell, file, or HTTP permissions in the WebView

## Support status

| Adapter | Standard setup | Source | Status |
| --- | ---: | --- | --- |
| Codex | Multiple `CODEX_HOME` profiles | Codex `app-server` `account/rateLimits/read` | Implemented |
| Claude Code | Multiple statusLine accounts | Claude Code `statusLine` `rate_limits` | Implemented |
| Other coding CLIs | - | An official, stable local interface is required | Adapter pending |

Codex integration follows the official [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [`CODEX_HOME` specification](https://learn.chatgpt.com/docs/config-file/environment-variables). Claude integration follows the official [status line specification](https://code.claude.com/docs/en/statusline) and [`CLAUDE_CONFIG_DIR` specification](https://code.claude.com/docs/en/env-vars).

Claude `rate_limits` appear for Claude.ai Pro and Max plans after the first API response in a session. The five-hour and seven-day windows can be absent independently. Missing values are never treated as 0%.

## Installation

### GitHub Releases

Download the unsigned source release from GitHub, or build locally as described below. Your operating system may show a standard first-run security warning for unsigned software.

### Build from source

Requirements:

- Node.js 20.19 or later
- Rust stable (the declared `Cargo.toml` minimum is 1.77.2; the minimum version has not been independently verified)
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2
- An official Codex CLI or Claude Code only when collecting real data

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for OS-specific requirements.

```bash
git clone https://github.com/OkiSugiyama/LLMStatus.git
cd LLMStatus
npm ci
npm run check
npm run tauri:build
```

Development mode:

```bash
npm run tauri:dev
```

Rust-only checks:

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Initial setup

1. Launch LLMStatus.
2. Open `Settings` and add an account with `+ Codex` or `+ Claude`.
3. Set the display name and confirm the adapter. Optionally select the detected local profile that this account represents. If an alias uses a profile outside the detected locations, select `Add existing profile directory` and paste its absolute `CODEX_HOME` or `CLAUDE_CONFIG_DIR` directory.
4. Select `Save settings`, then refresh the dashboard.

LLMStatus assigns a fresh internal Account ID with 128 bits from the Web Crypto CSPRNG every time an account is created and resolves the official Codex CLI from `PATH`. Removed IDs are not deliberately regenerated or reassigned, while existing saved IDs remain compatible. It lists existing safe profile directories detected from `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `.codex`, `.codex-*`, `.claude`, and `.claude-*`. An explicitly added directory must be an absolute UTF-8 path of at most 4096 bytes to an existing non-symlink directory narrower than a filesystem or home root. Explicit validation is shared across both adapters and limited to eight attempts per rolling second. LLMStatus canonicalizes the path and reads directory metadata only, never provider configuration contents. It does not read or execute shell startup files, aliases, functions, or scripts. Tokens, cookies, and configuration-file contents are not read or saved. Settings and sanitized observations remain in the OS-standard local application data area.

The `Resolved profile` row shows the directory name actually assigned to each account. For an alias such as `CLAUDE_CONFIG_DIR=/custom/profile claude`, add `/custom/profile`; do not paste the alias command itself. The same rule applies to a Codex alias that sets `CODEX_HOME`.

## Codex

### 1. Prepare Codex CLI

Install the official [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and verify it:

```bash
codex --version
```

LLMStatus resolves `codex` from `PATH`; account registration does not require an executable path or profile. One enabled Codex account may leave the profile unselected to use the default `CODEX_HOME`. Additional enabled Codex accounts must select distinct detected or explicitly added profiles. Explicit executable and profile paths already saved by an earlier version continue to work, and LLMStatus never reads authentication files in a profile directory.

## Claude Code

### 1. Prepare Claude Code

Follow the official [Claude Code setup](https://code.claude.com/docs/en/setup) and verify it:

```bash
claude --version
```

### 2. Capture the first usage snapshot

1. Add a Claude account in LLMStatus and optionally select its detected or explicitly added Claude profile. Repeat for every account you want to monitor; selected profiles must be distinct.
2. Save the account. An account with a selected existing non-symlink profile shows `Refresh Claude usage` while it has no readable observation or its previous observation has expired. An unselected account instead points back to Settings for profile selection or manual Account-ID snippet installation.
3. Select the button. LLMStatus opens an interactive Claude session and automatically submits the fixed prompt `Reply only with OK.` with Claude tools disabled. This sends one request through the selected profile and counts toward Claude usage.
4. The first refresh for each Claude profile shows Claude Code's own workspace trust dialog for the LLMStatus refresh workspace. Answer `Yes, I trust this folder` once for that profile; the preselected answer is `No, exit`, which closes Claude without refreshing and leaves the card waiting. The refresh action and the post-launch notice both state this before it happens. LLMStatus never answers this dialog for you and never bypasses it, and it never reads the profile's Claude configuration to check whether the dialog was already accepted.
5. After Claude replies, the statusLine collector runs and the card updates automatically.

The button starts the selected `CLAUDE_CONFIG_DIR` with an inline `--settings` override containing only that account's generated LLMStatus collector, disables Claude tools and non-configured MCP servers for the launch, ignores the profile's user, project, and local settings sources with `--setting-sources=`, and supplies the fixed refresh prompt as Claude's own initial-prompt argument. The override is one command argument, applies to that one Claude session, and temporarily replaces its displayed status line. LLMStatus does not read or modify the profile's `settings.json`, credentials, or existing statusLine.

Every refresh session runs in one fixed application-owned working directory, `claude-workspace` inside the LLMStatus data directory, instead of the home directory. Claude Code records workspace trust per configuration directory and working directory and never persists trust for a home directory, and it skips the statusLine command entirely until that workspace is trusted. A stable directory therefore turns the trust dialog into a single explicit acceptance per Claude profile rather than a prompt on every launch. LLMStatus sends no synthetic keystrokes, so the refresh needs no macOS Accessibility permission and no dialog can absorb typed input; only the documented Apple Events permission for Terminal is required. LLMStatus never passes `--dangerously-skip-permissions`, `--bare`, or any other flag that bypasses a permission decision or forces API-key authentication — Claude reports plan rate limits only for a subscription session. On macOS, the fixed command uses `/usr/bin/env` to resolve the executable from `PATH`, so a login-shell alias or function named `claude` cannot replace the selected profile. On Windows, LLMStatus resolves the system PowerShell directory through the operating system, starts the fixed Windows PowerShell host with profile loading disabled, and relies on the same user's `PATH` only to resolve the official `claude` executable.

After this upgrade, schema-2 and schema-3 Claude observations are intentionally hidden because their collectors were not bound to the exact source revision that generated them. Select `Refresh Claude usage` once for each selected profile to capture a schema-4 observation with correctly attributed data.

### 3. Optional persistent statusLine connection

The one-click request is enough to capture a snapshot when the selected Claude account exposes rate-limit data. To receive future updates when Claude is started outside LLMStatus, reopen Settings and select `Generate Claude integration example`.

1. If the profile has no statusLine, merge the displayed `statusLine` object into its `settings.json`. Never overwrite the entire file.
2. If the profile already has a statusLine, add the displayed `existingStatusLineIntegration.posix` to the existing script. First save all stdin in `LLMSTATUS_STATUS_INPUT`, and use that variable for the existing display logic as well. LLMStatus does not modify external settings automatically.

Each account receives a distinct internal Account ID. Install that account's generated command in the profile selected on the same row, or install it manually for an unselected account. The command embeds both the Account ID and its exact current source revision. A selected path records the profile mapping and advances that revision when the mapping changes. An old, removed, disabled, wrong-adapter, or previous-revision collector fails before persistence and is checked again immediately before atomic replacement. The settings are the only authority on which revision is current: a stored observation left behind by a retired revision is hidden from the dashboard and never blocks the current collector from writing, so an account cannot be stranded by its own unreadable data after an account is added again or a settings file is restored.

Generated form:

```json
{
  "statusLine": {
    "type": "command",
    "command": "<absolute-path-to-llmstatus> --collect --account-id <generated-id> --source-revision <current-positive-revision>"
  }
}
```

The collector limits stdin to 64 KiB and validates and stores only used percentages and Unix reset seconds for `rate_limits.five_hour` and `rate_limits.seven_day`. It retains no session ID, conversation, working directory, or token. The Claude status line receives only the stored safe percentages.

Claude Code supports one `statusLine`. Replacing an existing custom status line would remove its current display. LLMStatus does not silently change external settings; Settings generates an integration example that adds the collector to the existing script.

## Adding another coding CLI

LLMStatus intentionally has no generic adapter that passes arbitrary commands or arguments to an unknown CLI. A dedicated adapter requires an official stable local interface, a fixed process or hook boundary, an allowlisted output schema, resource limits, failure semantics, and tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security boundary

- Codex is started directly with adapter-fixed arguments, without a shell. The typed Claude bootstrap opens the OS terminal with a fixed `claude --settings` invocation and safely quotes only the backend-resolved selected profile path plus generated inline JSON. It accepts only Account ID from the WebView. On macOS, `/usr/bin/env` keeps the `claude` token out of shell command position so login-shell aliases and functions cannot redirect it to another profile. Claude Code also runs its statusLine through a shell by specification, so LLMStatus generates OS-specific quoting using only the current executable and a validated Account ID.
- Ambient Codex token variables are removed from child processes.
- Legacy explicit Codex executable paths must be absolute paths.
- Automatically assigned Account IDs contain fresh CSPRNG entropy and are restricted to safe filename characters; duplicate IDs and canonical-equivalent enabled profiles for the same adapter are rejected. Multiple unselected Claude accounts are allowed, but only one enabled Codex account may use the default profile.
- Codex app-server lifetime is limited to eight seconds. At most four sessions run across the process, and each session accepts at most 128 messages, 1 MiB aggregate stdout, a 128-frame reader queue, and 256 KiB per JSONL line.
- Claude input is limited to 64 KiB, observations to 16 KiB, and settings to 64 KiB.
- Invalid percentages, times, JSON, and unknown schemas are rejected.
- The WebView capability allowlist contains only event listen and unlisten; image-from-path, shell, filesystem, HTTP, menu, tray, and devtools commands are not exposed.
- Raw app-server or statusLine responses, stderr, email addresses, and credentials are never stored or displayed.
- Unavailable values are never displayed as 0%.

See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md). Do not include credentials or real data in public vulnerability reports.

## Local development verification

Release evidence is produced only on owner-controlled physical machines. From a clean checkout with the locked packages already available locally, run:

```bash
npm run check:release:local
```

The fixed command sequence, public-tree classification, deterministic export checks, and dependency-notice limits are documented in [`docs/release/README.md`](docs/release/README.md). The physical procedures are [`docs/macos-physical-smoke.md`](docs/macos-physical-smoke.md) and [`docs/windows-physical-smoke.md`](docs/windows-physical-smoke.md). An unsigned test artifact is never a release.

## Release

Before distributing a build, select the supported CPU architectures and a private vulnerability-reporting channel, complete physical tray/quit/sleep-resume/CLI checks on both OSes, inspect the exact bundles for license resources, and publish checksums for the unsigned artifacts. These checks improve release quality but are not required for local personal use.

## License

This project is provided under the [MIT License](LICENSE). Copyright (c) 2026 Oki Sugiyama. Provider cards use original provider-neutral CSS marks alongside the provider names; no provider logo image ships. Application-icon provenance and locked dependency inventory are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with corresponding texts in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
