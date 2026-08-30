# macOS physical smoke test

Use this checklist on a physical Mac before distribution. It complements, but does not replace, the physical Windows checklist.

Do not capture account labels, local profile paths, usage values, credentials, or raw provider payloads. Record only PASS/FAIL and non-sensitive diagnostics.

The revision-2 Claude Terminal checks below require direct human interaction.
They have not been performed for the current candidate. Use a disposable test
profile with a selected existing non-symlink directory, and do not inspect or
copy provider configuration contents into the report.

## Last run

- Date: 2026-08-15
- Host: physical arm64 Mac, macOS 26.5.2
- Source revision: `8461d83c7b05ef09395970fbfc126fa18a9390aa` (later repository changes through `d95eaa0` were documentation only)
- App: debug `.app`, version `0.2.0`
- Expected identifier: `com.okisugiyama.llmstatus`

Passed:

- [x] Bundle identifier and version are correct.
- [x] Initial dashboard and settings screen render.
- [x] Manual refresh completes.
- [x] A temporary Claude entry with a macOS absolute path saves and appears on the dashboard.
- [x] The temporary entry was removed and the final dashboard returned to `No accounts configured`.
- [x] The red close button hides the window without ending the process.
- [x] Normal application quit ends the process.

Pending because the UI automation could not address the macOS status-item region, and system sleep was intentionally not triggered:

- [ ] Menu bar icon appears exactly once.
- [ ] Left-clicking the icon restores and focuses the hidden window.
- [ ] Right-clicking the icon opens a menu containing `Show LLMStatus` and `Quit`.
- [ ] `Show LLMStatus` restores and focuses the hidden window.
- [ ] After at least 60 seconds of real system sleep, resume leaves the icon and window functional.
- [ ] Manual refresh completes after resume.
- [ ] `Quit` removes the window, menu bar icon, and process.

## Complete the remaining checks

1. Build or open the normal LLMStatus `.app`; do not use `tauri.e2e.conf.json`.
2. Confirm there is exactly one LLMStatus icon in the macOS menu bar.
3. Close the main window with the red close button.
4. Left-click the LLMStatus menu bar icon and confirm the main window returns and receives focus.
5. Close the window again, right-click the icon, select `Show LLMStatus`, and confirm the same result.
6. Close or leave the window visible, put the Mac to sleep for at least 60 seconds, then resume.
7. Confirm the icon and window still work, then press `Refresh` and verify completion without recording any values.
8. Right-click the icon, select `Quit`, and confirm the window, icon, and process disappear.
9. Record PASS/FAIL, the macOS version and architecture, and non-sensitive diagnostics only in the private release record.

## Claude Terminal usage refresh - NOT YET RUN

Before starting, record the candidate source revision, confirm the app is a
normal build, and prepare one saved enabled Claude account with no readable
schema-4 observation. Regenerate any persistent integration example so its
collector contains the current positive source revision. Keep any local before/after comparison of the disposable
profile's persistent Claude settings off the report; record only whether it
changed.

- [ ] With no Claude profile selected, the card shows Settings guidance and no `Refresh Claude usage` action. Manual Account-ID snippet generation remains available after saving and enabling the account.
- [ ] In Settings, `Resolved profile` identifies the selected directory by name. A disposable existing non-symlink directory outside automatic discovery can be added by absolute path, while a relative path and a symbolic-link directory are rejected without exposing directory contents.
- [ ] After selecting an existing non-symlink Claude profile and saving, the empty card shows exactly one `Refresh Claude usage` action and discloses that it sends one request counted toward Claude usage.
- [ ] With Terminal automation denied in macOS Privacy & Security, selecting the action opens no Claude session, reports only a sanitized launch failure in LLMStatus, exposes no profile path or command text, and leaves the app responsive.
- [ ] After explicitly allowing the documented Apple Events request, selecting the action opens exactly one Terminal session for the selected profile as the current user.
- [ ] With a disposable login-shell alias named `claude` pointing at a different disposable profile, selecting the action still starts the profile selected in LLMStatus. Record only PASS/FAIL and never either path or authentication state.
- [ ] The launched session uses the generated one-session inline statusLine settings, disables Claude tools, and automatically submits exactly `Reply only with OK.` as its initial prompt; it does not replace, merge, or edit persistent Claude settings.
- [ ] The session runs in the fixed `claude-workspace` directory inside the LLMStatus data directory, not the home directory. On the first refresh for a profile, Claude's own workspace trust dialog appears and waits; LLMStatus types nothing into it and no launch argument bypasses it. After accepting it once, later refreshes for that profile start without the dialog.
- [ ] With macOS Accessibility permission never granted to LLMStatus, the refresh still opens the session and submits the prompt; only the Apple Events permission for Terminal is required.
- [ ] Repeat the whole refresh for a second saved Claude profile. Its own trust acceptance, session, and observation are independent, and refreshing it leaves the first profile's stored observation unchanged.
- [ ] The one-session collector and generated persistent example both contain the saved Account ID and exact current source revision. An example generated before a disposable profile reassignment no longer updates the card.
- [ ] A local before/after comparison confirms the selected profile's persistent Claude settings are unchanged. Record only PASS/FAIL, never contents, paths, or checksums.
- [ ] The single automatic reply allows a sanitized observation to appear without recording any actual percentage, reset time, account identifier, prompt transcript, or provider payload.
- [ ] After a readable observation exists, the Terminal action is absent and normal refresh remains responsive.
- [ ] After the observation is made older than the 24-hour expiry boundary in the disposable data root, the action appears only while the selected profile is still valid.
- [ ] If the disposable selected directory becomes unavailable, the card shows sanitized Settings guidance without a path, command, raw error, or Terminal action; restoring or reselecting a valid profile recovers without restarting the app.
- [ ] The test record contains only the source revision, macOS version and architecture, PASS/FAIL for each item, and non-sensitive diagnostics.

## Automation caveat

Do not rely on `open --env LLMSTATUS_TEST_DATA_DIR=...` for an isolated settings-write test. In the 2026-08-15 run, that environment value did not reach the launched application. If a future automated Mac settings-write test is needed, first implement and review a deterministic harness that proves its data root before writing. Read-only UI checks may use an unconfigured profile, but never overwrite a real configured profile for smoke testing.
