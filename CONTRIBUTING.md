# Contributing to LLMStatus

This project is being prepared for publication. Keep changes local-only, least-privilege, and honest about unavailable values; never display failures as 0%. Contributions are provided under the same MIT License as this project.

## Development checks

```bash
npm ci --offline
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets settings::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets claude::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets collector
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets discovery::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets codex::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets claude_terminal::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

For the complete fixed local release-preparation sequence, start from a clean checkout with the locked npm packages and both documented Cargo target graphs already cached, then run:

```bash
npm run check:release:local
```

The command remains offline, resolves the effective npm cache and `CARGO_HOME` once, passes those exact locations to every child, and forces Cargo offline for every child process. This keeps `npm ci --offline` and dependency verification on the same configured cache on POSIX and Windows. It verifies the required public/excluded classifications, zero tracked hosted-workflow paths, repository secret scan, two-export determinism, and exact archive-bound dependency notices. It does not prove physical behavior, installer contents, signing, notarization, or publication readiness. A fresh Rust advisory result is unavailable without an explicitly approved advisory database update and must not be reported as zero vulnerabilities.

For a Tauri core check on macOS or Windows:

```bash
npm run tauri:build -- --debug --no-bundle
```

Never put real tokens, email addresses, cookies, or account IDs in fixtures.

Profile-resolution tests must use disposable directories. Cover absolute-path canonicalization, the 4096-byte path limit, all-attempt rolling-second rate limiting across adapters and concurrent calls, missing and relative paths, symbolic-link rejection, broad-root rejection, stale asynchronous completion, and frontend basename-only display. Do not inspect a real provider profile or source a shell startup file during tests.

### Live Claude statusLine smoke test

For a real Claude Code collector check, set an absolute temporary directory in `LLMSTATUS_TEST_DATA_DIR`, which debug builds recognize. Release builds ignore this variable.

1. Create a test-only `settings.json` in a temporary directory with one `claudeStatusLine` account using a non-real Account ID.
2. Pass the temporary `statusLine` override to Claude Code through its `--settings` option, and use the same `LLMSTATUS_TEST_DATA_DIR` and debug `llmstatus --collect --account-id <id> --source-revision <current-positive-revision>` command.
3. Run exactly one response in a trusted isolated workspace.
4. Check only the keys, ranges, and `0600` permissions of `observations/<id>.json`; never retain real usage values or raw statusLine JSON in logs, fixtures, or Git.

Relative paths are rejected and never fall back to the production directory. Do not overwrite a user's Claude or LLMStatus production settings for a smoke test.

### Claude Terminal refresh checks

Automated tests must validate the complete macOS and Windows executable/argument arrays, embedded Account ID and exact source revision, macOS `/usr/bin/env` alias isolation, system PowerShell resolution, disabled PowerShell profile loading, hostile quoting, inline-settings shape, disabled Claude tools, the exact backend-fixed `Reply only with OK.` prompt, schema-2/schema-3 invalidation, pre-replacement revision races, write ordering, and missing/wrong/disabled/symlink failure paths without opening a real terminal or starting Claude. The WebView supplies only Account ID; tests must prove labels and request text cannot become launch commands, prompts, or paths. A live check can expose private profile paths, authentication state, usage values, and consume provider usage, so perform one only through the applicable physical checklist and isolated live-smoke procedure. Never click the refresh action in production settings as part of an automated test.

### Windows GUI smoke test

The Windows GUI test uses the external `tauri-driver` and Node.js standard library without adding a test plugin to the production binary. Run it only on an owner-controlled local Windows machine. It verifies:

- WebView2 renders the initial and settings screens
- A Windows absolute `CLAUDE_CONFIG_DIR` can be saved
- Multiple unselected Claude accounts can be saved and appear on the dashboard
- Unselected Claude accounts show Settings guidance instead of a Terminal action that must fail
- Settings and observations are written only below the runner temporary directory in `LLMSTATUS_TEST_DATA_DIR`

For local execution, add Microsoft Edge WebDriver to `PATH`, install `tauri-driver` 2.0.6, and prepare an isolated debug binary and data directory.

```powershell
cargo install tauri-driver --version 2.0.6 --locked
npm ci
npm run tauri:build -- --debug --no-bundle --config src-tauri/tauri.e2e.conf.json
$env:LLMSTATUS_TEST_DATA_DIR = Join-Path $env:TEMP "llmstatus-e2e"
npm run test:e2e:windows
```

`tauri.e2e.conf.json` adds a debug port through the WebView2 API for WebView2 Runtime 150 and later test environments while preserving Wry defaults. This override is for local tests only; do not use it for normal or distribution builds.

The local WebView2 test covers basic operations. The visible system tray, restoring from the tray after closing the window, and sleep/resume require a physical normal-user Windows x64 environment and remain a separate release gate.

## Adding a coding CLI adapter

Propose a dedicated adapter for the CLI, never a generic command runner.

1. Cite official vendor documentation for the local interface and usage conditions.
2. Add a variant to `src-tauri/src/settings.rs` `AdapterKind`.
3. Add the same serialized name to `src/types.ts`.
4. Implement fixed-argument process spawning or an official-hook sanitizer in a Rust module.
5. Connect it to refresh and dashboard dispatch in `src-tauri/src/lib.rs`.
6. Show only the adapter's minimum required local fields in the settings UI.
7. Update the README support table, setup, and profile-separation instructions.

### Required acceptance criteria

- Do not use a shell. If an official hook requires one, quote generated text safely and never concatenate user input into arguments.
- Limit executables to auto-detection or an absolute path approved by the user.
- Never read credential stores, browser cookies, or provider configuration contents directly.
- Copy only allowlisted provider fields into new types.
- Bound input, line length, stored files, and process lifetime.
- Test zero, one, many, duplicate IDs, duplicate profiles, malformed input, timeout, and stale data.
- Preserve the provider's meaning of used and remaining; label derived values explicitly in the UI.
- Never put raw payloads or stderr in errors, logs, or fixtures.
- Explain macOS and Windows profile separation using official documentation.

## Assets and release provenance

- Keep the original LLMStatus application icon source and its repository provenance in the release tree.
- Do not add a provider logo or other third-party image without an existing local record of its official source, redistribution terms, trademark conditions, and required attribution.
- A trademark disclaimer is not redistribution permission. Use an original provider-neutral code-native mark when the required evidence is absent.
- Run `node scripts/dependency-notices.mjs generate` whenever a lockfile or redistributed asset changes, review both generated notice files, and commit them together. `verify` fails when either generated file is stale.
- Keep every immutable fallback material and its URL/SHA-256 association under `docs/release/license-materials/`. The verifier's independent approval oracle must also pin the complete record and exact VCS/repository/package/license/material association. Never substitute a representative text from an unrelated package. A package with no own material needs an exact same-release or VCS proof, or the documented official-SPDX exception for a verified material-less locked archive or release tree.
- The public source-tree rules are machine-readable in `docs/release/public-tree.json`; every newly tracked path must receive exactly one public or excluded classification.

## Pull requests

- Explain the purpose and any trust-boundary change.
- List the test commands and target OS.
- State any new external communication, permission, persistent data, or distribution processing.
- Never commit signing keys, notarization credentials, or CI secrets.

## License

Source code and contributions are provided under the [MIT License](LICENSE).
