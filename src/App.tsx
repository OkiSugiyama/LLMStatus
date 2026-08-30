import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  discoverConfigDirs,
  launchClaudeInTerminal,
  readClaudeStatusLineSnippet,
  readDashboard,
  readSettings,
  refreshDashboard,
  saveSettings,
  subscribeToClaudeObservationChanges,
  resolveConfigDir,
} from "./bridge";
import {
  CLAUDE_REFRESH_STARTED_NOTICE,
  CLAUDE_TRUST_PROMPT_GUIDANCE,
  createAccountId,
  createDashboardRefreshScheduler,
  DEFAULT_SETTINGS,
  EMPTY_DASHBOARD,
  formatObservedAt,
  formatPercent,
  formatResetAt,
  profileIdentityInUse,
  profileOptionDisabled,
  profileSelectionsReady,
  resolvedProfileLabel,
  remainingPercent,
  applyResolvedProfileCandidate,
  shouldOfferClaudeTerminal,
  statusLabel,
} from "./domain";
import type {
  AccountConfigView,
  AccountSnapshot,
  AdapterKind,
  AppSettingsView,
  ConfigCandidate,
  DashboardState,
  UsageWindow,
} from "./types";

const APP_ICON_URL = new URL("../src-tauri/icons/icon.png", import.meta.url).href;

function ProviderMark({ provider }: { provider: AccountSnapshot["provider"] }) {
  return (
    <span
      className={`provider-mark provider-mark--${provider}`}
      data-testid={`provider-mark-${provider}`}
      aria-hidden="true"
    >
      <span className="provider-mark__shape" />
    </span>
  );
}

function WindowMeter({ window }: { window: UsageWindow }) {
  const remaining = remainingPercent(window);
  return (
    <section className="meter" aria-label={`${window.label} usage`}>
      <div className="meter__heading">
        <span>{window.label}</span>
        <span className="meter__reset">{formatResetAt(window.resetsAt)}</span>
      </div>
      <div
        className="meter__track"
        role="progressbar"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
      >
        <span className="meter__fill" style={{ width: `${window.usedPercent}%` }} />
      </div>
      <div className="meter__values">
        <span><strong>{formatPercent(window.usedPercent)}</strong> used</span>
        <span><strong>{formatPercent(remaining)}</strong> remaining (calculated)</span>
      </div>
    </section>
  );
}

interface AccountCardProps {
  account: AccountSnapshot;
  launchingClaude: boolean;
  onLaunchClaude: (accountId: string) => void;
}

function AccountCard({ account, launchingClaude, onLaunchClaude }: AccountCardProps) {
  const descriptionId = `${account.id}-description`;
  return (
    <article
      className={`account-card account-card--${account.status}`}
      aria-describedby={descriptionId}
      data-testid={`account-card-${account.id}`}
    >
      <header className="account-card__header">
        <div className="account-card__identity">
          <ProviderMark provider={account.provider} />
          <div>
            <p className="account-card__provider">
              {account.provider === "openai" ? "OpenAI" : "Anthropic"}
            </p>
            <h2>{account.label}</h2>
          </div>
        </div>
        <span className={`status status--${account.status}`}>
          <span className="status__dot" aria-hidden="true" />
          {statusLabel(account.status)}
        </span>
      </header>

      <div className="account-card__body" id={descriptionId}>
        {account.windows.length > 0 ? (
          account.windows.map((window) => <WindowMeter key={window.id} window={window} />)
        ) : (
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">-</span>
            <p>{account.detail ?? "Usage is unavailable"}</p>
            {account.errorCode && <code>{account.errorCode}</code>}
            {shouldOfferClaudeTerminal(account) && (
              <div className="claude-terminal-action">
                <p>
                  Sends <code>Reply only with OK.</code> through this Claude profile to refresh usage.
                  This counts toward Claude usage.
                </p>
                <p className="claude-terminal-action__trust" data-testid={`claude-trust-guidance-${account.id}`}>
                  {CLAUDE_TRUST_PROMPT_GUIDANCE}
                </p>
                <button
                  className="primary-button claude-terminal-button"
                  data-testid={`launch-claude-${account.id}`}
                  type="button"
                  disabled={launchingClaude}
                  onClick={() => onLaunchClaude(account.id)}
                >
                  {launchingClaude ? "Refreshing Claude usage..." : "Refresh Claude usage"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="account-card__footer">
        Observed: {formatObservedAt(account.observedAt)}
        {account.status === "stale" && " - Showing the last value received"}
      </footer>
    </article>
  );
}

interface SettingsPanelProps {
  draft: AppSettingsView;
  saving: boolean;
  snippets: Record<string, string>;
  onDraftChange: Dispatch<SetStateAction<AppSettingsView>>;
  onSave: () => void;
  onCancel: () => void;
  onSnippet: (accountId: string) => void;
}

function profilesForAccount(
  adapterKind: AdapterKind,
  configDir: string | undefined,
  profileIdentity: string | undefined,
  discovered: ConfigCandidate[],
): ConfigCandidate[] {
  if (!configDir || discovered.some((candidate) => candidate.path === configDir)) {
    return discovered;
  }
  if (!profileIdentity) return discovered;
  return [
    { adapterKind, path: configDir, label: "Saved profile", profileIdentity },
    ...discovered.filter((candidate) => candidate.profileIdentity !== profileIdentity),
  ];
}

function SettingsPanel({
  draft,
  saving,
  snippets,
  onDraftChange,
  onSave,
  onCancel,
  onSnippet,
}: SettingsPanelProps) {
  const [profilesByAdapter, setProfilesByAdapter] = useState<Record<AdapterKind, ConfigCandidate[]>>({
    codexAppServer: [],
    claudeStatusLine: [],
  });
  const [discoveringByAdapter, setDiscoveringByAdapter] = useState<Record<AdapterKind, boolean>>({
    codexAppServer: true,
    claudeStatusLine: true,
  });
  const [discoveryFailedByAdapter, setDiscoveryFailedByAdapter] = useState<Record<AdapterKind, boolean>>({
    codexAppServer: false,
    claudeStatusLine: false,
  });
  const [profileImportOpenByAccount, setProfileImportOpenByAccount] = useState<Record<string, boolean>>({});
  const [profilePathByAccount, setProfilePathByAccount] = useState<Record<string, string>>({});
  const [profileImportErrorByAccount, setProfileImportErrorByAccount] = useState<Record<string, string>>({});
  const [resolvingProfileAccountId, setResolvingProfileAccountId] = useState<string | null>(null);

  const refreshProfiles = useCallback(async (adapterKind: AdapterKind) => {
    setDiscoveringByAdapter((current) => ({ ...current, [adapterKind]: true }));
    setDiscoveryFailedByAdapter((current) => ({ ...current, [adapterKind]: false }));
    try {
      const profiles = await discoverConfigDirs(adapterKind);
      setProfilesByAdapter((current) => ({ ...current, [adapterKind]: profiles }));
    } catch {
      setDiscoveryFailedByAdapter((current) => ({ ...current, [adapterKind]: true }));
    } finally {
      setDiscoveringByAdapter((current) => ({ ...current, [adapterKind]: false }));
    }
  }, []);

  useEffect(() => {
    void refreshProfiles("codexAppServer");
    void refreshProfiles("claudeStatusLine");
  }, [refreshProfiles]);

  const updateAccount = (index: number, patch: Partial<AccountConfigView>) => {
    const accounts = draft.accounts.map((account, current) =>
      current === index ? { ...account, ...patch } : account,
    );
    onDraftChange({ ...draft, accounts });
  };

  const addExistingProfile = async (account: AccountConfigView) => {
    const path = profilePathByAccount[account.id] ?? "";
    if (!path.trim()) {
      setProfileImportErrorByAccount((current) => ({
        ...current,
        [account.id]: "Enter an absolute profile directory.",
      }));
      return;
    }

    setResolvingProfileAccountId(account.id);
    setProfileImportErrorByAccount((current) => ({ ...current, [account.id]: "" }));
    const request = { account: { ...account } };
    try {
      const candidate = await resolveConfigDir(account.adapterKind, path);
      setProfilesByAdapter((current) => ({
        ...current,
        [account.adapterKind]: [
          candidate,
          ...current[account.adapterKind].filter((profile) =>
            profile.profileIdentity !== candidate.profileIdentity
            && profile.path !== candidate.path
          ),
        ],
      }));
      onDraftChange((current) => applyResolvedProfileCandidate(current, request, candidate));
      setProfilePathByAccount((current) => ({ ...current, [account.id]: "" }));
      setProfileImportOpenByAccount((current) => ({ ...current, [account.id]: false }));
    } catch (error) {
      setProfileImportErrorByAccount((current) => ({
        ...current,
        [account.id]: errorMessage(error),
      }));
    } finally {
      setResolvingProfileAccountId(null);
    }
  };

  const addAccount = (adapterKind: AdapterKind) => {
    const label = adapterKind === "codexAppServer" ? "Codex account" : "Claude account";
    const id = createAccountId(label, draft.accounts.map((account) => account.id));
    onDraftChange({
      ...draft,
      accounts: [
        ...draft.accounts,
        { id, label, adapterKind, enabled: true, sourceRevision: 0 },
      ],
    });
  };

  const removeAccount = (index: number) => {
    onDraftChange({
      ...draft,
      accounts: draft.accounts.filter((_, current) => current !== index),
    });
  };

  const profilesReady = profileSelectionsReady(draft.accounts);

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <fieldset className="settings-panel__fieldset" disabled={saving}>
      <div className="settings-panel__heading">
        <div>
          <p className="eyebrow">LOCAL CONFIGURATION</p>
          <h2 id="settings-title">Account settings</h2>
          <p>Display name and Adapter are the only required registration fields. Account IDs are generated internally, and provider profile selection is optional.</p>
        </div>
        <div className="settings-panel__actions">
          <button
            className="secondary-button"
            data-testid="add-codex-account"
            type="button"
            onClick={() => addAccount("codexAppServer")}
          >
            + Codex
          </button>
          <button
            className="secondary-button"
            data-testid="add-claude-account"
            type="button"
            onClick={() => addAccount("claudeStatusLine")}
          >
            + Claude
          </button>
        </div>
      </div>

      <div className="settings-basics">
        <label>
          Refresh interval (seconds)
          <input
            type="number"
            min={60}
            max={3600}
            value={draft.refreshIntervalSeconds}
            onChange={(event) => onDraftChange({
              ...draft,
              refreshIntervalSeconds: Number(event.target.value),
            })}
          />
        </label>
        <label>
          Mark Claude data stale after (minutes)
          <input
            type="number"
            min={1}
            max={1440}
            value={draft.staleAfterMinutes}
            onChange={(event) => onDraftChange({
              ...draft,
              staleAfterMinutes: Number(event.target.value),
            })}
          />
        </label>
      </div>

      {draft.accounts.length === 0 ? (
        <div className="settings-empty">
          Add a Codex or Claude account. No accounts are assumed initially.
        </div>
      ) : (
        <div className="account-settings-list">
          {draft.accounts.map((account, index) => (
            <article
              className="account-settings"
              data-testid={`account-settings-${index}`}
              key={`${account.id}-${index}`}
            >
              <header>
                <div>
                  <strong>{account.label || "Unnamed account"}</strong>
                  <span>{account.adapterKind === "codexAppServer" ? "Codex app-server" : "Claude statusLine"}</span>
                </div>
                <div className="account-settings__toggles">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={account.enabled}
                      disabled={!account.enabled && profileIdentityInUse(
                        draft.accounts,
                        account.adapterKind,
                        account.profileIdentity,
                        index,
                      )}
                      onChange={(event) => updateAccount(index, { enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <button className="danger-button" type="button" onClick={() => removeAccount(index)}>
                    Remove
                  </button>
                </div>
              </header>

              <div className="settings-fields">
                <label>
                  Display name
                  <input
                    data-testid={`account-label-${index}`}
                    value={account.label}
                    maxLength={80}
                    onChange={(event) => updateAccount(index, { label: event.target.value })}
                  />
                </label>
                <label>
                  Adapter
                  <select
                    data-testid={`account-adapter-${index}`}
                    value={account.adapterKind}
                    onChange={(event) => updateAccount(index, {
                      adapterKind: event.target.value as AdapterKind,
                      executablePath: undefined,
                      configDir: undefined,
                      profileIdentity: undefined,
                    })}
                  >
                    <option value="codexAppServer">
                      Codex app-server
                    </option>
                    <option value="claudeStatusLine">
                      Claude statusLine
                    </option>
                  </select>
                </label>
                <div className="settings-fields__wide profile-field">
                    <p className="resolved-profile" data-testid={`resolved-profile-${index}`}>
                      <span>Resolved profile</span>
                      <strong>{resolvedProfileLabel(account)}</strong>
                    </p>
                    <label>
                      {account.adapterKind === "codexAppServer" ? "Codex profile (optional)" : "Claude profile (optional)"}
                      <select
                        data-testid={`account-config-dir-${index}`}
                        value={account.configDir ?? ""}
                        onChange={(event) => {
                          const path = event.target.value || undefined;
                          const selected = path
                            ? profilesForAccount(
                              account.adapterKind,
                              account.configDir,
                              account.profileIdentity,
                              profilesByAdapter[account.adapterKind],
                            ).find((candidate) => candidate.path === path)
                            : undefined;
                          updateAccount(index, {
                            configDir: path,
                            profileIdentity: selected?.profileIdentity,
                          });
                        }}
                      >
                        <option
                          value=""
                          disabled={profileOptionDisabled(
                            draft.accounts,
                            index,
                            undefined,
                          )}
                        >
                          {account.adapterKind === "codexAppServer"
                            ? "Use the default Codex profile"
                            : "No Claude profile selected"}
                        </option>
                        {profilesForAccount(
                          account.adapterKind,
                          account.configDir,
                          account.profileIdentity,
                          profilesByAdapter[account.adapterKind],
                        ).map((candidate) => (
                          <option
                            key={candidate.path}
                            value={candidate.path}
                            disabled={profileOptionDisabled(
                              draft.accounts,
                              index,
                              candidate.profileIdentity,
                            )}
                          >
                            {candidate.label} - {candidate.path}
                          </option>
                        ))}
                      </select>
                      <small>
                        {account.adapterKind === "codexAppServer"
                          ? "Leave unselected to use the default CODEX_HOME, or select a profile for another account. Codex itself is resolved automatically from PATH."
                          : "Leave unselected for manual Account-ID snippet installation, or select a profile to enable the one-message usage refresh."}
                        {" "}LLMStatus detects directory names only; it does not read provider settings or credentials.
                      </small>
                    </label>
                    <button
                      className="text-button profile-refresh-button"
                      type="button"
                      disabled={discoveringByAdapter[account.adapterKind]}
                      onClick={() => void refreshProfiles(account.adapterKind)}
                    >
                      {discoveringByAdapter[account.adapterKind] ? "Finding profiles..." : "Refresh profiles"}
                    </button>
                    {discoveryFailedByAdapter[account.adapterKind] && (
                      <small className="profile-discovery-error" role="status">
                        Profiles could not be detected. Try refreshing profiles.
                      </small>
                    )}
                    {!discoveringByAdapter[account.adapterKind]
                      && !discoveryFailedByAdapter[account.adapterKind]
                      && profilesByAdapter[account.adapterKind].length === 0 && (
                        <small className="profile-discovery-note" role="status">
                          No detected profiles. You can still save this account without a profile.
                        </small>
                    )}
                    <div className="profile-import">
                      <button
                        className="text-button profile-import-toggle"
                        type="button"
                        aria-expanded={Boolean(profileImportOpenByAccount[account.id])}
                        onClick={() => {
                          setProfileImportOpenByAccount((current) => ({
                            ...current,
                            [account.id]: !current[account.id],
                          }));
                          setProfileImportErrorByAccount((current) => ({
                            ...current,
                            [account.id]: "",
                          }));
                        }}
                      >
                        {profileImportOpenByAccount[account.id]
                          ? "Cancel directory entry"
                          : "Add existing profile directory"}
                      </button>
                      {profileImportOpenByAccount[account.id] && (
                        <div className="profile-import-fields">
                          <label>
                            Absolute profile directory
                            <input
                              data-testid={`profile-directory-input-${index}`}
                              value={profilePathByAccount[account.id] ?? ""}
                              placeholder={account.adapterKind === "codexAppServer"
                                ? "/Users/name/.codex-work"
                                : "/Users/name/.claude-work"}
                              spellCheck={false}
                              autoCapitalize="none"
                              autoCorrect="off"
                              onChange={(event) => {
                                const path = event.target.value;
                                setProfilePathByAccount((current) => ({
                                  ...current,
                                  [account.id]: path,
                                }));
                                setProfileImportErrorByAccount((current) => ({
                                  ...current,
                                  [account.id]: "",
                                }));
                              }}
                            />
                          </label>
                          <button
                            className="secondary-button profile-import-submit"
                            type="button"
                            disabled={resolvingProfileAccountId === account.id}
                            onClick={() => void addExistingProfile(account)}
                          >
                            {resolvingProfileAccountId === account.id
                              ? "Validating..."
                              : "Use directory"}
                          </button>
                          <small>
                            Paste only the directory used by {account.adapterKind === "codexAppServer"
                              ? <code>CODEX_HOME</code>
                              : <code>CLAUDE_CONFIG_DIR</code>}.
                            {" "}LLMStatus validates directory metadata and does not read its contents or shell aliases.
                          </small>
                          {profileImportErrorByAccount[account.id] && (
                            <small className="profile-discovery-error" role="status">
                              {profileImportErrorByAccount[account.id]}
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
              </div>

              {account.adapterKind === "claudeStatusLine" && (
                <div className="snippet-box">
                  <button className="text-button" type="button" onClick={() => onSnippet(account.id)}>
                    Generate Claude integration example
                  </button>
                  <small>
                    Optional for persistent updates outside the dashboard bootstrap.
                    The selected profile is not modified. Add the generated
                    {" "}<code>existingStatusLineIntegration</code> to the existing script.
                  </small>
                  {snippets[account.id] && <pre aria-label="Claude integration example">{snippets[account.id]}</pre>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <div className="settings-footer">
        <div>
          <p>Profiles are optional. Enabled accounts cannot reuse an explicit profile, and only one enabled Codex account can use the default profile.</p>
          {!profilesReady && (
            <p className="settings-validation-error" role="status">
              Resolve the enabled profile conflict before saving. Select a distinct profile, disable an account, or remove it.
            </p>
          )}
        </div>
        <div>
          <button className="secondary-button" type="button" onClick={onCancel}>Back</button>
          <button
            className="primary-button"
            data-testid="save-settings"
            type="button"
            disabled={!profilesReady}
            onClick={onSave}
          >
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </div>
      </fieldset>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : "An unexpected error occurred";
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardState>(EMPTY_DASHBOARD);
  const [settings, setSettings] = useState<AppSettingsView>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<AppSettingsView>(DEFAULT_SETTINGS);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const [launchingClaudeId, setLaunchingClaudeId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Checking local integrations");
  const refreshScheduler = useMemo(() => createDashboardRefreshScheduler(async (manual) => {
    setRefreshing(true);
    try {
      const next = manual ? await refreshDashboard() : await readDashboard();
      setDashboard(next);
      setNotice(manual ? "Updated" : "Loaded local data");
    } catch (error) {
      setNotice(`Update failed: ${errorMessage(error)}`);
    } finally {
      setRefreshing(false);
    }
  }), []);

  useEffect(() => {
    void readSettings()
      .then((value) => {
        setSettings(value);
        setDraft(value);
      })
      .catch((error) => setNotice(`Could not load settings: ${errorMessage(error)}`));
  }, []);

  useEffect(() => {
    void refreshScheduler.refresh(true);
    const interval = window.setInterval(
      () => void refreshScheduler.refresh(true),
      settings.refreshIntervalSeconds * 1000,
    );
    return () => window.clearInterval(interval);
  }, [refreshScheduler, settings.refreshIntervalSeconds]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void subscribeToClaudeObservationChanges(() => {
      if (active) void refreshScheduler.observationChanged();
    })
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refreshScheduler]);

  const summary = useMemo(() => {
    const total = dashboard.accounts.length;
    const live = dashboard.accounts.filter((account) => account.status === "live").length;
    if (total === 0) return "No accounts configured";
    if (live === total) return `${total} account${total === 1 ? "" : "s"} all live`;
    if (live === 0) return "No live accounts";
    return `${live}/${total} accounts live`;
  }, [dashboard]);

  const openSettings = () => {
    setDraft(structuredClone(settings));
    setView("settings");
  };

  const persistSettings = async () => {
    setSaving(true);
    try {
      const saved = await saveSettings(draft);
      setSettings(saved);
      setDraft(saved);
      setSnippets({});
      setView("dashboard");
      setNotice("Settings saved");
      await refreshScheduler.refresh(true);
    } catch (error) {
      setNotice(`Could not save settings: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const showSnippet = async (accountId: string) => {
    try {
      const snippet = await readClaudeStatusLineSnippet(accountId);
      setSnippets((current) => ({ ...current, [accountId]: snippet }));
    } catch (error) {
      setNotice(`Could not generate the statusLine example: ${errorMessage(error)}`);
    }
  };

  const openClaudeInTerminal = async (accountId: string) => {
    setLaunchingClaudeId(accountId);
    try {
      await launchClaudeInTerminal(accountId);
      setNotice(CLAUDE_REFRESH_STARTED_NOTICE);
    } catch (error) {
      setNotice(`Could not start Claude usage refresh: ${errorMessage(error)}`);
    } finally {
      setLaunchingClaudeId(null);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <img
              className="brand-icon"
              data-testid="brand-app-icon"
              src={APP_ICON_URL}
              alt=""
            />
            <h1>LLMStatus</h1>
          </div>
        </div>
        <div className="topbar__actions">
          <button className="secondary-button" data-testid="open-settings" type="button" onClick={openSettings}>
            Settings
          </button>
          <button className="refresh-button" type="button" onClick={() => void refreshScheduler.refresh(true)} disabled={refreshing}>
            <span aria-hidden="true" className={refreshing ? "spin" : ""}>R</span>
            {refreshing ? "Updating..." : "Refresh"}
          </button>
        </div>
      </header>

      {view === "settings" ? (
        <SettingsPanel
          draft={draft}
          saving={saving}
          snippets={snippets}
          onDraftChange={setDraft}
          onSave={() => void persistSettings()}
          onCancel={() => setView("dashboard")}
          onSnippet={(accountId) => void showSnippet(accountId)}
        />
      ) : (
        <>
          <section className="summary" aria-label="Connection status">
            <span className="summary__pulse" aria-hidden="true" />
            <strong>{summary}</strong>
            <span>Auto-refresh: {settings.refreshIntervalSeconds}s</span>
          </section>

          {dashboard.accounts.length === 0 ? (
            <section className="onboarding">
              <span aria-hidden="true">+</span>
              <h2>Add your first account</h2>
              <p>Register a local Codex or Claude Code configuration to see usage limits here.</p>
              <button className="primary-button" type="button" onClick={openSettings}>Open settings</button>
            </section>
          ) : (
            <section className="account-grid" aria-label="Account usage">
              {dashboard.accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  launchingClaude={launchingClaudeId === account.id}
                  onLaunchClaude={(accountId) => void openClaudeInTerminal(accountId)}
                />
              ))}
            </section>
          )}

        </>
      )}

      <footer className="app-footer">
        <span aria-live="polite">{notice}</span>
        <span>v0.2.0</span>
      </footer>
    </main>
  );
}
