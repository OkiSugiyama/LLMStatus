import type {
  AccountConfig,
  AccountConfigView,
  AccountSnapshot,
  AppSettings,
  AppSettingsView,
  ConfigCandidate,
  DashboardState,
  UsageWindow,
} from "./types";

export const EMPTY_DASHBOARD: DashboardState = {
  generatedAt: new Date(0).toISOString(),
  accounts: [],
};

export const DEFAULT_SETTINGS: AppSettingsView = {
  schemaVersion: 1,
  refreshIntervalSeconds: 300,
  staleAfterMinutes: 10,
  accounts: [],
};

export function normalizeDashboard(state: DashboardState): DashboardState {
  const seen = new Set<string>();
  return {
    ...state,
    accounts: state.accounts.filter((account) => {
      if (seen.has(account.id)) return false;
      seen.add(account.id);
      return true;
    }),
  };
}

export type AccountEntropySource = (byteLength: number) => Uint8Array;

function secureEntropy(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function createAccountId(
  label: string,
  existingIds: string[],
  entropySource: AccountEntropySource = secureEntropy,
): string {
  const base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 31) || "account";
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const entropy = entropySource(16);
    if (entropy.byteLength < 16) {
      throw new Error("Account ID entropy source returned fewer than 128 bits");
    }
    const suffix = Array.from(entropy, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const candidate = `${base}-${suffix}`.slice(0, 64);
    if (!existingIds.includes(candidate)) return candidate;
  }
  throw new Error("Could not generate a unique Account ID");
}

export interface ProfileResolutionRequest {
  account: AccountConfigView;
}

export function applyResolvedProfileCandidate(
  settings: AppSettingsView,
  request: ProfileResolutionRequest,
  candidate: ConfigCandidate,
): AppSettingsView {
  const index = settings.accounts.findIndex((account) => account.id === request.account.id);
  if (index < 0) return settings;
  const account = settings.accounts[index];
  const expected = request.account;
  if (candidate.adapterKind !== expected.adapterKind
    || account.label !== expected.label
    || account.adapterKind !== expected.adapterKind
    || account.enabled !== expected.enabled
    || account.sourceRevision !== expected.sourceRevision
    || account.executablePath !== expected.executablePath
    || account.configDir !== expected.configDir
    || account.profileIdentity !== expected.profileIdentity) {
    return settings;
  }
  const accounts = [...settings.accounts];
  accounts[index] = {
    ...account,
    configDir: candidate.path,
    profileIdentity: candidate.profileIdentity,
  };
  return { ...settings, accounts };
}

export interface DashboardRefreshScheduler {
  refresh: (manual: boolean) => Promise<void>;
  observationChanged: () => Promise<void>;
}

export function createDashboardRefreshScheduler(
  run: (manual: boolean) => Promise<void>,
): DashboardRefreshScheduler {
  let inFlight = false;
  let observationPending = false;

  const execute = async (manual: boolean, fromObservation: boolean): Promise<void> => {
    if (inFlight) {
      if (fromObservation) observationPending = true;
      return;
    }
    inFlight = true;
    try {
      await run(manual);
    } finally {
      inFlight = false;
      if (observationPending) {
        observationPending = false;
        await execute(false, false);
      }
    }
  };

  return {
    refresh: (manual) => execute(manual, false),
    observationChanged: () => execute(false, true),
  };
}

// Settings and discovery return backend-owned profile identities separately
// from usable paths. Keep comparison exact and never derive an identity in the
// WebView.
export function profileIdentityInUse(
  accounts: AccountConfigView[],
  adapterKind: AccountConfig["adapterKind"],
  profileIdentity: string | undefined,
  exceptIndex?: number,
): boolean {
  if (!profileIdentity && adapterKind === "claudeStatusLine") return false;
  return accounts.some((account, index) =>
    index !== exceptIndex
    && account.enabled
    && account.adapterKind === adapterKind
    && account.profileIdentity === profileIdentity,
  );
}

export function profileOptionDisabled(
  accounts: AccountConfigView[],
  accountIndex: number,
  profileIdentity: string | undefined,
): boolean {
  const account = accounts[accountIndex];
  return Boolean(account?.enabled && profileIdentityInUse(
    accounts,
    account.adapterKind,
    profileIdentity,
    accountIndex,
  ));
}

export function profileSelectionsReady(accounts: AccountConfigView[]): boolean {
  return accounts.every((account, index) =>
    !account.enabled
    || !profileIdentityInUse(accounts, account.adapterKind, account.profileIdentity, index)
  );
}

export function profileDisplayName(configDir: string): string {
  const components = configDir.split(/[\\/]+/).filter(Boolean);
  return components.at(-1) ?? "Selected profile";
}

export function resolvedProfileLabel(
  account: Pick<AccountConfigView, "adapterKind" | "configDir">,
): string {
  if (account.configDir) return profileDisplayName(account.configDir);
  return account.adapterKind === "codexAppServer"
    ? "Default Codex profile"
    : "No Claude profile selected";
}

export function settingsForSave(settings: AppSettingsView): AppSettings {
  return {
    schemaVersion: settings.schemaVersion,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    staleAfterMinutes: settings.staleAfterMinutes,
    accounts: settings.accounts.map((account): AccountConfig => {
      const saved: AccountConfig = {
        id: account.id,
        label: account.label,
        adapterKind: account.adapterKind,
        enabled: account.enabled,
        sourceRevision: account.sourceRevision,
      };
      if (account.executablePath !== undefined) {
        saved.executablePath = account.executablePath;
      }
      if (account.configDir !== undefined) {
        saved.configDir = account.configDir;
      }
      return saved;
    }),
  };
}

export function shouldOfferClaudeTerminal(account: AccountSnapshot): boolean {
  return account.provider === "anthropic"
    && account.windows.length === 0
    && account.errorCode === "claude_refresh_available";
}

/**
 * Claude Code asks whether the LLMStatus refresh workspace is trusted the first
 * time a profile runs there, and its preselected answer closes Claude instead of
 * accepting. An unanswered question therefore looks exactly like a broken
 * button: the terminal window opens, the fixed prompt never runs, no statusLine
 * observation is written, and the card keeps waiting. The action states the
 * question and the required answer before it appears.
 *
 * The wording is fixed frontend copy. LLMStatus never answers the question and
 * never reads the profile's own Claude configuration to decide whether it was
 * already answered, so this guidance stays visible for every refresh.
 */
export const CLAUDE_TRUST_PROMPT_GUIDANCE =
  "The first refresh of a Claude profile opens Claude Code's workspace trust question in Terminal. Answer \"Yes, I trust this folder\" once for that profile. The preselected answer is \"No, exit\", which closes Claude without refreshing.";

export const CLAUDE_REFRESH_STARTED_NOTICE =
  "Claude usage refresh started in Terminal. Answer \"Yes, I trust this folder\" if Terminal asks; the card updates after Claude replies.";

export function remainingPercent(window: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function formatPercent(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(digits)}%`;
}

export function formatObservedAt(value: string | null, now = new Date()): string {
  if (!value) return "Not available";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Time unknown";
  const seconds = Math.max(0, Math.round((now.getTime() - timestamp.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return timestamp.toLocaleString("en-US");
}

export function formatResetAt(value: string | null): string {
  if (!value) return "Reset time unknown";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Reset time unknown";
  return `Resets at ${timestamp.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function statusLabel(status: AccountSnapshot["status"]): string {
  return {
    live: "Live",
    stale: "Stale",
    unavailable: "Unavailable",
    error: "Error",
  }[status];
}
