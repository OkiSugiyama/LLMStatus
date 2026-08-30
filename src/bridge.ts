import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS, EMPTY_DASHBOARD, normalizeDashboard, settingsForSave } from "./domain";
import type { AdapterKind, AppSettingsView, ConfigCandidate, DashboardState } from "./types";

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
export async function readDashboard(): Promise<DashboardState> {
  if (!isTauriRuntime()) return EMPTY_DASHBOARD;
  return normalizeDashboard(await invoke<DashboardState>("dashboard_state"));
}

export async function refreshDashboard(): Promise<DashboardState> {
  if (!isTauriRuntime()) return EMPTY_DASHBOARD;
  return normalizeDashboard(await invoke<DashboardState>("refresh_dashboard"));
}

export async function subscribeToClaudeObservationChanges(
  onChange: () => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen("llmstatus://claude-observation-changed", () => onChange());
}

export async function readSettings(): Promise<AppSettingsView> {
  if (!isTauriRuntime()) return DEFAULT_SETTINGS;
  return invoke<AppSettingsView>("app_settings");
}

export async function saveSettings(settings: AppSettingsView): Promise<AppSettingsView> {
  if (!isTauriRuntime()) return settings;
  return invoke<AppSettingsView>("save_app_settings", { settings: settingsForSave(settings) });
}

export async function readClaudeStatusLineSnippet(accountId: string): Promise<string> {
  return invoke<string>("claude_status_line_snippet", { accountId });
}

export async function launchClaudeInTerminal(accountId: string): Promise<void> {
  return invoke<void>("launch_claude_terminal", { accountId });
}

export async function discoverConfigDirs(adapterKind: AdapterKind): Promise<ConfigCandidate[]> {
  if (!isTauriRuntime()) return [];
  return invoke<ConfigCandidate[]>("discover_config_dirs", { adapterKind });
}

export async function resolveConfigDir(
  adapterKind: AdapterKind,
  path: string,
): Promise<ConfigCandidate> {
  if (!isTauriRuntime()) {
    throw new Error("Profile directory validation requires the desktop app");
  }
  return invoke<ConfigCandidate>("resolve_config_dir", { adapterKind, path });
}
