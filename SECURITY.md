# Security policy

## Supported versions

There is no signed public release yet. Security fixes target the current `main` branch.

## Protected data

LLMStatus temporarily receives and sanitizes provider input. It does not persist, display, or log:

- OAuth access or refresh tokens
- Browser cookies, session headers, or authentication databases
- API keys
- Codex or Claude configuration-file contents
- Raw statusLine or app-server output and stderr
- Conversations, prompts, working directories, or session IDs

It stores only local Account ID, local display name, adapter configuration paths, used percentage, reset time, observation time, and schema version. Configuration paths and usage times can be private, so they are never sent externally.

## Trust boundaries

1. The React WebView calls only typed dashboard, settings, profile-discovery, explicit-profile-resolution, statusLine-snippet, and Claude-bootstrap commands.
2. The WebView capability allowlist contains only event listen and unlisten. It receives no image-from-path, shell, filesystem, HTTP, menu, tray, or devtools permission.
3. Only the Rust backend starts official CLI processes or the fixed Claude Terminal refresh.
4. Codex uses adapter-fixed app-server arguments and an allowlisted RPC surface.
5. The Claude collector accepts only a saved, enabled Claude Account ID plus its exact positive current source revision and sanitizes into closed observation schema 4.
6. Cloud backends, telemetry, and auto-updaters are outside the trust boundary.

## Validation and failure behavior

- New Account IDs contain at least 96 bits of Web Crypto CSPRNG entropy and are not deliberately regenerated after removal. Account IDs, labels, canonical-equivalent enabled profiles, absolute paths, counts, adapter fields, thresholds, and settings schemas are validated before saving. Multiple unselected Claude accounts are allowed; only one enabled Codex account may use the default profile.
- Invalid percentages, times, JSON, and oversized input are rejected.
- Unavailable values are never displayed as 0%.
- When a previous value is retained, it is marked stale and includes its observation time.
- Stored observations older than 24 hours are not displayed.
- Refresh results started before a profile change and Claude observations from an old revision are not displayed. Settings reload and source-revision assignment occur under the cross-process atomic-write lock, so stale settings writers cannot reuse a revision for different sources. Collector commands bind Account ID and source revision together; the backend validates both before sanitization and again under that lock immediately before replacement. A stale collector cannot replace a newer revision or newer observation.
- Schema-2 and schema-3 observations are unavailable and are not migrated or reinterpreted. Only structurally valid schema 4 matching the current saved account and revision is displayed. An older rollback may ignore schema 4 but must never reinterpret it as an older schema.
- Codex processes time out after eight seconds and are stopped. A process-global limiter permits at most four sessions; each session accepts at most 128 parsed messages, 1 MiB aggregate stdout, and 128 queued reader frames.
- Ambient `CODEX_ACCESS_TOKEN` and `CODEX_API_KEY` are not passed to Codex children; ambient `CODEX_SQLITE_HOME` is also removed when a per-account `CODEX_HOME` is used.
- App-server JSONL is limited to 256 KiB per line, Claude stdin to 64 KiB, observations to 16 KiB, settings to 64 KiB, and explicit profile paths to 4096 UTF-8 bytes. Explicit profile resolution shares an eight-attempt rolling-second process-wide limit across adapters; every call is charged before validation.
- Error details never contain raw data.
- The Claude Terminal refresh accepts only a saved, enabled Claude Account ID. The backend resolves the account and selected profile, checks the profile with filesystem metadata, rejects missing or symbolic-link directories, and passes an inline settings object containing only the generated collector command. It disables Claude tools and supplies the backend-fixed `Reply only with OK.` initial prompt. On macOS, the fixed `/usr/bin/env` boundary prevents login-shell aliases and functions named `claude` from overriding the backend-selected `CLAUDE_CONFIG_DIR`. The click therefore sends one provider request and counts toward Claude usage, as disclosed beside the action. Labels, prompt text, command text, executables, and paths from the WebView cannot enter the launch plan.

## Known limitations

- PATH auto-detection cannot defend against changes made by the same OS user. An absolute path to a trusted official CLI is recommended.
- The profile selectors are not arbitrary command execution. Automatic discovery checks only `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, the standard profile directories, and the provider-specific `.codex-*` and `.claude-*` prefixes in the home directory. The sole WebView path-metadata command accepts only an adapter and bounded user-entered absolute directory path, verifies filesystem metadata, rejects unavailable paths, symbolic-link directories, filesystem roots, and the user's home root, then returns a canonical path and comparison identity. Neither route recurses, executes or reads shell aliases, nor reads configuration or credential contents.
- Executable publisher and code-signature verification is not implemented.
- The Claude Terminal refresh resolves the executable from the user's terminal `PATH`. This is an explicit same-user trust limitation; a different executable placed earlier on that `PATH` cannot be distinguished without publisher or code-signature verification. macOS uses the fixed absolute `/usr/bin/env` executable so shell aliases and functions cannot participate in that lookup. On Windows, the PowerShell executable does not use `PATH`: LLMStatus obtains the system directory from Windows, appends the fixed Windows PowerShell location, and disables PowerShell profile loading. On macOS, the application declares why it sends an Apple event to Terminal and the first launch can require the user to approve that automation; LLMStatus does not bypass or answer the OS prompt.
- Terminal refresh is shown only when the backend has just validated the selected profile and returns the fixed `claude_refresh_available` code. Unselected and unavailable profiles instead return fixed Settings guidance codes and cannot gain launch eligibility from display text. Manual generated Account-ID snippet installation does not require a selected profile.
- Copying the same authentication state to another configuration directory cannot be detected.
- Complete defense against the same OS user who can modify local data is out of scope.
- If Claude Code already has a statusLine, LLMStatus does not safely merge or edit settings automatically. Settings shows a fixed collector integration example for the user to add explicitly.

## Reporting a vulnerability

Do not post access tokens, configuration files, raw provider responses, personal paths, or vulnerability details in a public issue. A private vulnerability-reporting channel and security contact have not yet been selected. Until the repository publishes one, there is no approved private intake route; retain the report privately and check this policy again later.

If credentials may have entered logs, the UI, stored files, or fixtures, stop the release and prioritize impact assessment and credential revocation.

## Supply-chain verification

`node scripts/dependency-notices.mjs verify` checks the exact npm lock inventory and the locked Cargo graph selected for the documented macOS and Windows targets using only local metadata and the caches selected by effective npm configuration and `CARGO_HOME`. It cryptographically binds every npm tarball to `package-lock.json`, every selected `.crate` to `Cargo.lock`, and every immutable fallback file to both its public provenance record and a separate hard-coded approval oracle before accepting an exact VCS/repository/package/license/material association. The local runner independently rejects tracked hosted workflows and scans every tracked regular file for ASCII and UTF-16 credential/private-key patterns. `npm audit --offline` is also part of the local source check. A fresh Rust advisory result requires a separately approved advisory database update and is currently unavailable; this limitation is not a zero-vulnerability claim. Every eventual installer or archive still requires direct inspection to confirm that the project license and both third-party notice files are present.
