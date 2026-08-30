export type AccountId = string;
export type Provider = "openai" | "anthropic";
export type ObservationStatus = "live" | "stale" | "unavailable" | "error";
export type AdapterKind = "codexAppServer" | "claudeStatusLine";

export interface ConfigCandidate {
  adapterKind: AdapterKind;
  path: string;
  label: string;
  profileIdentity: string;
}

export interface AccountConfig {
  id: string;
  label: string;
  adapterKind: AdapterKind;
  enabled: boolean;
  sourceRevision: number;
  executablePath?: string;
  configDir?: string;
}

export interface AppSettings {
  schemaVersion: number;
  refreshIntervalSeconds: number;
  staleAfterMinutes: number;
  accounts: AccountConfig[];
}

export interface AccountConfigView extends AccountConfig {
  profileIdentity?: string;
}

export interface AppSettingsView {
  schemaVersion: number;
  refreshIntervalSeconds: number;
  staleAfterMinutes: number;
  accounts: AccountConfigView[];
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  durationMinutes: number | null;
}
export interface AccountSnapshot {
  id: AccountId;
  provider: Provider;
  label: string;
  status: ObservationStatus;
  observedAt: string | null;
  windows: UsageWindow[];
  detail: string | null;
  errorCode: string | null;
}

export interface DashboardState {
  generatedAt: string;
  accounts: AccountSnapshot[];
}
