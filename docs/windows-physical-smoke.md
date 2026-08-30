# Windows x64 physical smoke test

This procedure is not for public distribution of unsigned LLMStatus. It is a short-lived local test of the system tray and sleep/resume on physical Windows x64 as a normal user.

The revision-2 Claude Terminal section is required for the current candidate
and has not yet been run. Never record account labels, profile paths, usage
values, credentials, raw provider payloads, generated inline JSON, or command
text. Record only PASS/FAIL and non-sensitive diagnostics.

## 1. Build and verify the local artifact

1. On the physical Windows x64 machine, check out the exact source revision under test. Confirm the tracked checkout is clean and do not use a remote build service.
2. Run the fixed source validation from that checkout, then build the normal debug executable without bundling:

```powershell
npm run check:release:local
npm run tauri:build -- --debug --no-bundle
```

3. Record the source revision locally with `git rev-parse HEAD`. Run the following in PowerShell and retain the result only with the short-lived local test record.

```powershell
(Get-FileHash .\src-tauri\target\debug\llmstatus.exe -Algorithm SHA256).Hash.ToLowerInvariant()
```

4. Confirm the recorded source revision and SHA-256 identify the exact local executable under test. SmartScreen may warn because it is unsigned. Do not run it as administrator, upload it, or retain it after the check.

## 2. Launch and system tray

1. Launch `LLMStatus.exe` as a normal user and confirm that the main window appears.
2. Confirm that exactly one LLMStatus icon appears in the taskbar system tray, including hidden icons.
3. Close the main window with its top-right `X`. Confirm that the process remains and the tray icon remains.
4. Left-click the tray icon and confirm that the main window returns and receives focus.
5. Close the window again, choose `Show LLMStatus` from the tray context menu, and confirm that it returns.

## 3. Sleep/resume

1. Put the PC to sleep with LLMStatus running.
2. Wait at least 60 seconds, then resume.
3. Confirm that the tray icon remains and clicking it restores the window.
4. Press `Refresh` and confirm that the UI remains responsive. Do not record actual usage values.
5. Close the window and restore it from the tray once more.

## 4. Claude Terminal usage refresh - NOT YET RUN

Use a normal, non-administrator Windows x64 account and a trusted same-user
`PATH` containing the official `claude` executable. Prepare a disposable
selected existing non-symlink Claude profile and one saved enabled account with
no readable schema-4 observation. Regenerate any persistent integration
example so its collector contains the current positive source revision.
Compare persistent Claude settings locally before and
after, but do not put contents, paths, or checksums in the report.

- [ ] With no Claude profile selected, the card shows Settings guidance and no `Refresh Claude usage` action. Manual Account-ID snippet generation remains available after saving and enabling the account.
- [ ] In Settings, `Resolved profile` identifies the selected directory by name. A disposable existing non-symlink directory outside automatic discovery can be added by absolute path, while a relative path and a symbolic-link directory are rejected without exposing directory contents.
- [ ] After selecting the disposable profile and saving, the empty card shows exactly one `Refresh Claude usage` action and discloses that it sends one request counted toward Claude usage.
- [ ] Selecting the action opens exactly one new console as the same normal user and starts the selected Claude profile.
- [ ] Process inspection confirms the console host is the standard system Windows PowerShell executable, not a `powershell.exe` found through user `PATH`. Do not record its absolute path.
- [ ] PowerShell profile loading is disabled for the launched console, while resolution of the official `claude` executable follows the documented same-user `PATH` trust boundary.
- [ ] The generated inline settings are passed for only that session, Claude tools are disabled, exactly `Reply only with OK.` is automatically submitted as the initial prompt, and persistent Claude settings are not replaced, merged, or edited.
- [ ] The session runs in the fixed `claude-workspace` directory inside the LLMStatus data directory, not the user profile directory. On the first refresh for a profile, Claude's own workspace trust dialog appears and waits; LLMStatus types nothing into it and no launch argument bypasses it. After accepting it once, later refreshes for that profile start without the dialog.
- [ ] Repeat the whole refresh for a second saved Claude profile. Its own trust acceptance, session, and observation are independent, and refreshing it leaves the first profile's stored observation unchanged.
- [ ] The one-session collector and generated persistent example both contain the saved Account ID and exact current source revision. An example generated before a disposable profile reassignment no longer updates the card.
- [ ] A local before/after comparison confirms the selected profile's persistent Claude settings are unchanged. Record only PASS/FAIL.
- [ ] The single automatic reply allows a sanitized observation to appear without recording any actual percentage, reset time, account identifier, prompt transcript, or provider payload.
- [ ] After a readable observation exists, the Terminal action is absent and normal refresh remains responsive.
- [ ] After the observation is made older than the 24-hour expiry boundary in the disposable data root, the action appears only while the selected profile is still valid.
- [ ] If the disposable selected directory becomes unavailable, the card shows sanitized Settings guidance without a path, command, raw error, or launch action; restoring or reselecting a valid profile recovers without restarting the app.
- [ ] The test record contains only the source revision, Windows version and architecture, PASS/FAIL for each item, and non-sensitive diagnostics.

## 5. Quit and clean up

1. Choose `Quit` from the tray context menu and confirm that the window, tray icon, and LLMStatus process all end.
2. Delete the unsigned binary and extracted directory after the test.

## 6. Report format

Report results only in the following format. Do not include account names,
profile paths, usage values, credentials, commands, or generated settings.

```text
Windows version:
Launch: PASS / FAIL
tray icon: PASS / FAIL
Hide with X: PASS / FAIL
Restore by left click: PASS / FAIL
Restore from menu: PASS / FAIL
Restore after sleep/resume: PASS / FAIL
Refresh after resume: PASS / FAIL
Quit from menu: PASS / FAIL
Unselected Claude guidance: PASS / FAIL
Selected-profile Terminal action: PASS / FAIL
Normal-user Terminal launch: PASS / FAIL
System PowerShell host and NoProfile: PASS / FAIL
Selected Claude profile: PASS / FAIL
Persistent Claude settings unchanged: PASS / FAIL
Sanitized failure and recovery: PASS / FAIL
Responsive after Terminal checks: PASS / FAIL
No sensitive evidence retained: PASS / FAIL
Notes (no secrets):
```
