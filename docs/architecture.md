# Architecture

## Product boundary

LLMStatus does not perform provider authentication. It displays only usage-limit metadata supplied by already-authenticated official local CLIs.

```text
AppSettings -- account registry --------------------------------+
                                                               |
Codex profile N -- CODEX_HOME -- app-server/stdio -------------+-- Rust core -- typed Tauri commands -- React UI
Claude profile N -- CLAUDE_CONFIG_DIR/statusLine -- collector -+
```

## Settings model

The settings schema is `schemaVersion: 1`. The initial state has zero accounts; no count or provider combination is assumed.

Each account has:

- `id`: safe local ID used for storage; new IDs combine a label prefix with at least 96 bits from Web Crypto CSPRNG entropy
- `label`: UI display name
- `adapterKind`: `codexAppServer` or `claudeStatusLine`
- `enabled`
- `sourceRevision`: backend-owned value updated when the source changes
- `executablePath`: optional absolute path for Codex only
- `configDir`: `CODEX_HOME` or `CLAUDE_CONFIG_DIR`

One enabled Codex account may omit `configDir` and use the default profile. Additional enabled Codex accounts use distinct explicit profiles. Multiple enabled Claude accounts may omit `configDir` for manual Account-ID snippet installation, while explicit enabled Claude profiles must be distinct. Explicit paths are compared after canonicalization. Existing canonical paths keep exact case, so case-sensitive Windows directories that differ only by case remain distinct; unresolved paths use lexical normalization and conservative Windows ASCII folding. A selected `CLAUDE_CONFIG_DIR` records which profile receives each command and changes the source revision when that mapping changes. Revision advancement fails instead of saturating at `u64::MAX`. Settings contain no credentials.

Settings commands return an `AppSettingsView` projection. It preserves every exact saved `configDir` and adds a backend-owned, response-only `profileIdentity` for accounts with a path. The save command accepts plain `AppSettings`; the frontend strips response identities before invocation, Rust does not deserialize them into schema 1, and persistence and provider launch continue to use only `configDir`.

## React UI

- Render zero or more cards in the order returned by the backend.
- Display used percentage as the primary value.
- Display remaining percentage as the derived value `100 - used`.
- Never convert unavailable data to 0%.
- Use color and English status labels together.
- Require only display name and adapter during registration; generate Account ID internally and keep detected profile selection optional.
- Assign a fresh CSPRNG-backed safe local ID for every creation, including remove/re-add, and resolve the Codex executable from `PATH`.
- Preserve optional paths already present in saved settings and include saved paths in the profile selector.
- Display the basename of the resolved profile for every account without exposing its full path in the summary row.
- Compare saved and discovered profiles only by the backend's response-only `profileIdentity` for option availability and save readiness. Select, display, and save the separate `path` or `configDir`; unchanged saves retain the raw saved path spelling.
- Offer a Claude Terminal refresh only when the backend returns the fixed `claude_refresh_available` error code after validating a saved enabled Claude account, its selected usable profile, and the absence of a readable current observation. Expired observations can receive the same code. The backend opens an interactive session with Claude tools disabled and supplies only the fixed `Reply only with OK.` prompt, passed as Claude's own initial-prompt argument after the `--` boundary so the variadic `--tools` option cannot absorb it. Unselected and unavailable profiles return fixed `claude_profile_required` or `claude_profile_unavailable` codes; display copy never grants eligibility.
- Re-find an account by its non-reused ID and compare the complete draft account after an asynchronous explicit-path response. Deletion, adapter changes, or later edits make the response stale and prevent it from applying.

## Config discovery

The Codex and Claude profile selectors use typed backend helpers. Automatic discovery does not run an arbitrary shell or `grep`. It checks only `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, the standard `.codex` and `.claude` directories, and `.codex-*` or `.claude-*` directories directly below the home directory. It returns at most 256 canonical-deduplicated candidates for existing non-symlink directories; each candidate has the exact validated canonical `path` plus a separate comparison-only `profileIdentity`. Home enumeration examines at most 256 direct entries.

For aliases that point elsewhere, the WebView can submit one adapter and one absolute UTF-8 directory string of at most 4096 bytes to `resolve_config_dir`, the sole WebView path-metadata command. Rust charges every invocation to one process-global eight-attempt rolling-second limit shared by both adapters, then requires an existing normal directory, rejects a symbolic-link leaf and broad filesystem or home roots, canonicalizes the result, and returns the same candidate shape. The helper does not accept or evaluate alias text. Neither route recurses, reads shell startup files, executes commands, or reads configuration or credential contents. Candidate identities are never transformed back into paths or passed to an adapter.

## Tauri/Rust core

- Expose no arbitrary command execution or file reading to the WebView.
- Grant the WebView only Tauri event listen and unlisten capabilities; image-from-path, shell, filesystem, HTTP, menu, tray, and devtools permissions are absent.
- Expose one typed explicit-profile command that accepts only an adapter and path, performs metadata validation, and returns a canonical candidate without reading directory contents.
- Expose one typed Claude Terminal command that accepts only a saved Account ID; no command text or path is accepted from the WebView.
- Run every Claude refresh session in one fixed application-owned working directory below the LLMStatus data root. Claude Code skips its statusLine command until the working directory is trusted, records that trust per configuration directory and working directory, and never persists trust for a home directory, so a terminal window's default home directory would block the collector on every launch and for every profile. The directory is created before the launch, is rejected if it is a symbolic link, and is never answered on the user's behalf.
- Send no synthetic keystrokes and use no macOS Accessibility permission. Terminal receives the whole invocation, including the refresh prompt, as one argument-passed shell command, so no dialog Claude may show can absorb injected input.
- Ignore the profile's user, project, and local settings sources for the launch so an existing statusLine cannot replace the generated one, and never pass a flag that bypasses a permission decision or forces API-key authentication. Claude reports plan rate limits only for a subscription session, so API-key authentication would silently empty the collected data.
- Validate settings before saving them to the OS-standard settings location.
- Expand only enabled accounts into the dashboard.
- Refresh Codex accounts in independent short-lived processes.
- Mark Claude observations stale after 10 minutes by default and expire stored previous values after 24 hours.
- Always mark retained old Codex values stale.
- Discard refresh results started during a settings change by checking the revision.

## Codex adapter

The adapter starts the configured executable, or auto-detected `codex`, without a shell. It passes `CODEX_HOME` only when `configDir` is set.

To prevent account mix-ups, ambient `CODEX_ACCESS_TOKEN` and `CODEX_API_KEY` are not inherited by child processes. When using a per-account `CODEX_HOME`, ambient `CODEX_SQLITE_HOME` is also removed.

After initialization it calls:

- `account/read`
- `account/rateLimits/read`
- `account/usage/read` (rate-limit display continues if this fails)

Only `account/rateLimits/updated` notifications are accepted. A process-global permit pool allows at most four app-server sessions even when refresh requests overlap. Every session has one eight-second deadline, accepts at most 128 parsed messages and 1 MiB aggregate stdout, uses a bounded 128-frame reader queue, and limits each JSONL line to 256 KiB. Byte and message budgets are charged before parsing or queueing, and the permit is released on every return or unwind path.

## Claude collector

The same executable is started in collector mode:

```text
llmstatus --collect --account-id <configured-id> --source-revision <positive-current-revision>
```

On each run, the collector verifies before reading stdin that the ID exists, is enabled, uses the `claudeStatusLine` adapter, and has the exact source revision embedded when the command was generated. It copies only allowlisted fields from statusLine JSON into observation schema 4:

- Used percentage for the five-hour and seven-day windows
- Unix reset seconds (legacy RFC 3339 is also accepted)
- Observation time
- Safe Account ID
- Schema version
- Source revision, which invalidates old observations after a source change

Labels are applied from current settings at display time rather than frozen in observation files.

Settings and observation replacements share a cross-process OS-handle lock that is released automatically when a process exits. A settings writer reloads the latest on-disk settings and assigns source revisions while holding that lock, so stale writers cannot reuse the same revision for different sources. The collector re-reads settings under the lock before writing its temporary file and immediately before atomic replacement. It also refuses to replace a higher source revision or a same-revision observation with an equal or newer timestamp. A removed, disabled, wrong-adapter, reassigned, or old-revision collector therefore cannot overwrite or become renderable as current data.

Because Claude Code has one `statusLine`, Settings shows two integration examples. Without a custom statusLine, configure the collector directly. With an existing display, pass the same stdin to both the existing display and the collector. LLMStatus never edits or overwrites Claude `settings.json` or an existing script automatically.

For a Claude account with no observation, the dashboard can open one temporary
interactive session in the OS terminal. The backend resolves the saved account,
requires a selected non-symlink profile directory, generates an inline settings
object containing only that account's collector, and launches:

```text
/usr/bin/env CLAUDE_CONFIG_DIR=<selected-profile> claude --settings <generated-inline-json>
```

macOS passes the fixed command as an argument to an AppleScript handler rather
than interpolating it into AppleScript source. The absolute `/usr/bin/env`
boundary resolves the `claude` executable from `PATH` without placing its name
in shell command position, so login-shell aliases and functions cannot replace
the backend-selected profile. Windows asks the operating
system for its system directory, appends the fixed Windows PowerShell path,
disables PowerShell profile loading, and passes a safely quoted fixed script to
a new console. Only resolution of the official `claude` executable uses the
same user's `PATH`. The WebView cannot supply shell text, executable paths, or
configuration paths.
Claude's command-line override applies only to that session, so persistent
settings and any existing statusLine are not edited. The existing observation
monitor performs the subsequent dashboard update.

Observation schema 4 is the first version bound to the Account ID and exact
source revision embedded at collector generation. Schema-2 and schema-3 files
remain unavailable and are never migrated or reinterpreted because they do not
prove that provenance. A successful schema-4 write may atomically replace one;
a failed write leaves it unavailable. An older rollback may ignore schema 4 but
must never reinterpret it as an older schema.

After a successful local observation replacement, the backend checks the
app-owned observation directory once per second using filesystem metadata
only. It considers only regular `.json` files and records file length,
modification time, and stable platform file identity when available (Unix
device and inode; Windows volume, file index, and creation metadata), with a
safe fallback when platform identity is unavailable. It does not open, parse,
log, or include file identities, names, or paths in the event. A changed
directory fingerprint emits the payload-free
`llmstatus://claude-observation-changed` event. The
WebView responds by calling the existing `dashboard_state` command, so the
dashboard reflects new Claude data without starting a Codex refresh. If an
event arrives during another refresh, it coalesces exactly one immediate
`dashboard_state` reread after that refresh. The configured refresh interval
remains the fallback when the window is open.

## Adapter extension boundary

There is no generic adapter that executes user input as a command. A new adapter must be compile-time code with an official interface, minimum data schema, process boundary, size and time limits, failure display, and tests.

## Cross-platform decisions

- UI and core are shared through Tauri 2.
- Persistent paths resolve through the `dirs` crate in the OS-standard location.
- Codex CLI startup uses no shell syntax, quote expansion, or environment expansion.
- The user-requested Claude bootstrap is the single typed terminal boundary. It uses fixed shell syntax and OS-specific single-argument quoting for the backend-owned selected profile and generated settings JSON. Windows PowerShell profiles are disabled.
- Only the statusLine command pasted into Claude is safely quoted per OS.
- Release preparation uses owner-controlled local source checks and non-bundle builds. Windows runtime behavior and physical behavior remain separate prerequisites.

## Release assets

The application icon is the original LLMStatus icon. The canonical raster
source is `src-tauri/icons/app-icon-source.png`; repository provenance and its
relationship to the generated icon set are recorded in
`THIRD_PARTY_NOTICES.md`. Provider cards use original CSS-only neutral marks
alongside provider names. No provider logo image is part of the release tree.

Every tracked path is classified by `docs/release/public-tree.json`. The
release-tree tool exports only the public set to disposable temporary
directories, scans it, and compares two independently generated source
manifests. The scanner checks every exported regular file as ASCII and both
UTF-16 byte orders, and fixed independent actions reject tracked hosted
workflows and repository secret patterns. The dependency-notice tool covers
the npm lock and the union of the locked macOS arm64 and Windows x64 Cargo
graphs. It uses the caches selected by effective npm configuration and
`CARGO_HOME`, authenticates exact npm and Cargo archives before resolving each
package's material, and permits only pinned same-release, exact-VCS, or
documented official-SPDX fallbacks. A manifest-independent approval oracle
pins every exceptional source, hash, repository, VCS, package, license, and
material association. The project license and both
notice files are configured as future Tauri bundle resources, but a no-bundle
build cannot prove their presence in an installer or archive.

## Deferred decisions

- Signed distribution automation and auto-updater
- Supported distribution CPU architectures
- Private vulnerability-reporting channel and security contact
- CLI executable publisher and code-signature verification
- Safe composition with an existing Claude status line
- Account identity fingerprinting, if possible without reading credentials
- Dedicated adapters other than Codex and Claude
