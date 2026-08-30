import { describe, expect, it } from "vitest";
import {
  applyResolvedProfileCandidate,
  CLAUDE_REFRESH_STARTED_NOTICE,
  CLAUDE_TRUST_PROMPT_GUIDANCE,
  createAccountId,
  createDashboardRefreshScheduler,
  formatObservedAt,
  formatPercent,
  normalizeDashboard,
  profileIdentityInUse,
  profileDisplayName,
  profileOptionDisabled,
  profileSelectionsReady,
  remainingPercent,
  resolvedProfileLabel,
  settingsForSave,
  shouldOfferClaudeTerminal,
} from "./domain";
import type { AccountConfigView, AppSettingsView, DashboardState, UsageWindow } from "./types";

const window: UsageWindow = {
  id: "five-hour",
  label: "5 hours",
  usedPercent: 37.5,
  resetsAt: null,
  durationMinutes: 300,
};

describe("usage semantics", () => {
  it("derives and labels the remaining percentage from an explicit used percentage", () => {
    expect(remainingPercent(window)).toBe(62.5);
    expect(formatPercent(remainingPercent(window))).toBe("62.5%");
  });

  it("never displays a percentage outside the quota range", () => {
    expect(remainingPercent({ ...window, usedPercent: 150 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: -10 })).toBe(100);
  });
});
describe("dashboard normalization", () => {
  it("preserves configured order and drops duplicate IDs", () => {
    const partial: DashboardState = {
      generatedAt: "2026-08-15T00:00:00Z",
      accounts: [
        {
          id: "client-claude",
          provider: "anthropic",
          label: "Work",
          status: "live",
          observedAt: "2026-08-15T00:00:00Z",
          windows: [],
          detail: null,
          errorCode: null,
        },
        {
          id: "client-claude",
          provider: "anthropic",
          label: "Duplicate",
          status: "error",
          observedAt: null,
          windows: [],
          detail: null,
          errorCode: "duplicate",
        },
      ],
    };
    expect(normalizeDashboard(partial).accounts.map((account) => account.id)).toEqual([
      "client-claude",
    ]);
  });

  it("creates dynamic account IDs with deterministic injected 128-bit entropy", () => {
    const id = createAccountId(
      "Claude Work",
      [],
      (byteLength) => Uint8Array.from({ length: byteLength }, (_, index) => index),
    );
    expect(id).toBe("claude-work-000102030405060708090a0b0c0d0e0f");
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("creates backend-valid IDs for every visible label shape", () => {
    const backendAccountId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const labels = [
      "_",
      "___",
      "!!!",
      "---___",
      "Claude!",
      "Cafe\u0301",
      "\u65e5\u672c\u8a9e",
      "\ud83e\udd16",
    ];
    for (const label of labels) {
      const id = createAccountId(label, [], (byteLength) => {
        expect(byteLength).toBe(16);
        return new Uint8Array(byteLength).fill(1);
      });
      expect(id, label).toMatch(backendAccountId);
      expect(id, label).toMatch(/-[0-9a-f]{32}$/);
      expect(id.length, label).toBeLessThanOrEqual(64);
    }
    expect(createAccountId("_", [], () => new Uint8Array(16).fill(1)))
      .toBe("account-01010101010101010101010101010101");
  });

  it("rejects an injected entropy source with fewer than 128 bits", () => {
    expect(() => createAccountId("_", [], () => new Uint8Array(15)))
      .toThrow("Account ID entropy source returned fewer than 128 bits");
  });

  it("generates a fresh non-reused ID after removal and re-addition", () => {
    let generation = 0;
    const entropy = (byteLength: number) => {
      generation += 1;
      return new Uint8Array(byteLength).fill(generation);
    };
    const removedId = createAccountId("Claude Work", [], entropy);
    const replacementId = createAccountId("Claude Work", [], entropy);
    expect(removedId).not.toBe(replacementId);
    expect(removedId).toMatch(/-[0-9a-f]{32}$/);
    expect(replacementId).toMatch(/-[0-9a-f]{32}$/);
  });

  it("retries a current-ID collision with fresh injected entropy", () => {
    let generation = 1;
    const entropy = (byteLength: number) => new Uint8Array(byteLength).fill(generation++);
    const existing = createAccountId("Codex", [], () => new Uint8Array(16).fill(1));
    expect(createAccountId("Codex", [existing], entropy))
      .toBe("codex-02020202020202020202020202020202");
  });

  it("detects profile reuse within the same adapter", () => {
    const account: AccountConfigView = {
      id: "codex-account",
      label: "Codex account",
      adapterKind: "codexAppServer",
      enabled: true,
      sourceRevision: 1,
      configDir: "/profiles/codex-work",
      profileIdentity: "/canonical/codex-work",
    };
    expect(profileIdentityInUse(
      [account],
      "codexAppServer",
      "/canonical/codex-work",
    )).toBe(true);
    expect(profileIdentityInUse(
      [account],
      "codexAppServer",
      "/canonical/codex-work",
      0,
    )).toBe(false);
    expect(profileIdentityInUse(
      [account],
      "claudeStatusLine",
      "/canonical/codex-work",
    )).toBe(false);
  });

  it("allows one Codex default profile and rejects only conflicting enabled profiles", () => {
    const account: AccountConfigView = {
      id: "codex-one",
      label: "Codex one",
      adapterKind: "codexAppServer",
      enabled: true,
      sourceRevision: 1,
    };
    expect(profileSelectionsReady([account])).toBe(true);
    expect(profileSelectionsReady([
      account,
      { ...account, id: "codex-two", label: "Codex two" },
    ])).toBe(false);
    expect(profileSelectionsReady([
      account,
      {
        ...account,
        id: "codex-two",
        label: "Codex two",
        configDir: "/profiles/codex-two",
        profileIdentity: "/canonical/codex-two",
      },
    ])).toBe(true);
  });

  it("prevents a discovered Claude profile from being selected twice", () => {
    const account: AccountConfigView = {
      id: "claude-work",
      label: "Claude work",
      adapterKind: "claudeStatusLine",
      enabled: true,
      sourceRevision: 1,
      configDir: "/profiles/claude-work",
      profileIdentity: "/canonical/claude-work",
    };
    expect(profileIdentityInUse(
      [account],
      "claudeStatusLine",
      "/canonical/claude-work",
    )).toBe(true);
    expect(profileIdentityInUse(
      [account],
      "claudeStatusLine",
      "/canonical/claude-work",
      0,
    )).toBe(false);
    expect(profileIdentityInUse(
      [{ ...account, enabled: false }],
      "claudeStatusLine",
      "/canonical/claude-work",
    )).toBe(false);
  });

  it("allows multiple unselected Claude accounts but rejects duplicate explicit profiles", () => {
    const account: AccountConfigView = {
      id: "claude-one",
      label: "Claude one",
      adapterKind: "claudeStatusLine",
      enabled: true,
      sourceRevision: 1,
    };
    expect(profileSelectionsReady([
      account,
      { ...account, id: "claude-two", label: "Claude two" },
    ])).toBe(true);
    expect(profileSelectionsReady([
      {
        ...account,
        configDir: "/profiles/shared/raw-first",
        profileIdentity: "/canonical/shared",
      },
      {
        ...account,
        id: "claude-two",
        label: "Claude two",
        configDir: "/profiles/shared",
        profileIdentity: "/canonical/shared",
      },
    ])).toBe(false);
  });

  it("keeps exact paths distinct from identities and strips identities from save payloads", () => {
    const settings: AppSettingsView = {
      schemaVersion: 1,
      refreshIntervalSeconds: 300,
      staleAfterMinutes: 10,
      accounts: [
        {
          id: "codex-case",
          label: "Codex case",
          adapterKind: "codexAppServer",
          enabled: false,
          sourceRevision: 7,
          configDir: "C:/Profiles/Work",
          profileIdentity: "C:/Profiles/Work",
        },
        {
          id: "claude-unresolved",
          label: "Claude unresolved",
          adapterKind: "claudeStatusLine",
          enabled: false,
          sourceRevision: 4,
          configDir: "D:/Profiles/TEAM/../Work",
          profileIdentity: "d:/profiles/work",
        },
      ],
    };

    const payload = settingsForSave(settings);
    expect(payload.accounts.map((account) => account.configDir)).toEqual([
      "C:/Profiles/Work",
      "D:/Profiles/TEAM/../Work",
    ]);
    expect(JSON.stringify(payload)).not.toContain("profileIdentity");
    expect(settings.accounts.map((account) => account.profileIdentity)).toEqual([
      "C:/Profiles/Work",
      "d:/profiles/work",
    ]);
  });

  it.each([
    "codexAppServer",
    "claudeStatusLine",
  ] as const)("uses backend-issued duplicate identities for %s option and readiness checks", (adapterKind) => {
    const profileIdentity = `c:/profiles/${adapterKind.toLowerCase()}/work`;
    const accounts: AccountConfigView[] = [
      {
        id: "saved-account",
        label: "Saved account",
        adapterKind,
        enabled: true,
        sourceRevision: 1,
        configDir: `C:/Profiles/${adapterKind}/Work`,
        profileIdentity,
      },
      {
        id: "new-account",
        label: "New account",
        adapterKind,
        enabled: false,
        sourceRevision: 1,
        configDir: `c:/profiles/${adapterKind}/work`,
        profileIdentity,
      },
    ];

    expect(profileIdentityInUse(accounts, adapterKind, profileIdentity, 1)).toBe(true);
    expect(profileSelectionsReady(accounts)).toBe(true);
    accounts[1] = { ...accounts[1], enabled: true };
    expect(profileOptionDisabled(accounts, 1, profileIdentity)).toBe(true);
    expect(profileSelectionsReady(accounts)).toBe(false);
  });

  it.each([
    "codexAppServer",
    "claudeStatusLine",
  ] as const)("keeps backend-confirmed case-only directories distinct for %s", (adapterKind) => {
    const accounts: AccountConfigView[] = [
      {
        id: "upper-profile",
        label: "Upper profile",
        adapterKind,
        enabled: true,
        sourceRevision: 1,
        configDir: "C:/Profiles/Work",
        profileIdentity: "C:/Profiles/Work",
      },
      {
        id: "lower-profile",
        label: "Lower profile",
        adapterKind,
        enabled: true,
        sourceRevision: 1,
        configDir: "C:/Profiles/work",
        profileIdentity: "C:/Profiles/work",
      },
    ];

    expect(profileSelectionsReady(accounts)).toBe(true);
    expect(profileOptionDisabled(accounts, 1, "C:/Profiles/Work")).toBe(true);
    expect(profileOptionDisabled(accounts, 1, "C:/Profiles/work")).toBe(false);
  });

  it("disables an in-use Codex default without clearing a conflicting selected draft", () => {
    const accounts: AccountConfigView[] = [
      {
        id: "codex-default",
        label: "Codex default",
        adapterKind: "codexAppServer",
        enabled: true,
        sourceRevision: 1,
      },
      {
        id: "codex-conflict",
        label: "Codex conflict",
        adapterKind: "codexAppServer",
        enabled: true,
        sourceRevision: 1,
      },
    ];

    expect(profileOptionDisabled(accounts, 1, undefined)).toBe(true);
    expect(accounts[1].configDir).toBeUndefined();
    expect(profileSelectionsReady(accounts)).toBe(false);
    expect(profileOptionDisabled(accounts, 1, "/profiles/codex-work")).toBe(false);
  });

  it("shows the resolved profile name without exposing its full path", () => {
    expect(profileDisplayName("/Users/name/.claude-work/")).toBe(".claude-work");
    expect(profileDisplayName("C:\\Users\\name\\.codex-personal")).toBe(".codex-personal");
    expect(resolvedProfileLabel({
      adapterKind: "claudeStatusLine",
      configDir: "/Users/name/custom-claude",
    })).toBe("custom-claude");
  });

  it("labels provider defaults when no explicit profile is selected", () => {
    expect(resolvedProfileLabel({ adapterKind: "codexAppServer" }))
      .toBe("Default Codex profile");
    expect(resolvedProfileLabel({ adapterKind: "claudeStatusLine" }))
      .toBe("No Claude profile selected");
  });
});

describe("freshness copy", () => {
  it("uses an injected clock for deterministic relative timestamps", () => {
    expect(
      formatObservedAt("2026-08-15T00:00:00Z", new Date("2026-08-15T00:03:00Z")),
    ).toBe("3m ago");
  });
});

describe("Claude Terminal bootstrap", () => {
  const account = {
    id: "claude-work",
    provider: "anthropic" as const,
    label: "Claude work",
    status: "unavailable" as const,
    observedAt: null,
    windows: [],
    detail: "Waiting for Claude Code statusLine data",
    errorCode: "claude_refresh_available",
  };

  it("is offered only for the backend allowlisted launchable-profile code", () => {
    expect(shouldOfferClaudeTerminal(account)).toBe(true);
    expect(shouldOfferClaudeTerminal({ ...account, provider: "openai" })).toBe(false);
    expect(shouldOfferClaudeTerminal({ ...account, windows: [window] })).toBe(false);
    expect(shouldOfferClaudeTerminal({
      ...account,
      observedAt: "2026-08-15T00:00:00Z",
      detail: "The observed data has expired",
      errorCode: "claude_refresh_available",
    })).toBe(true);
    expect(shouldOfferClaudeTerminal({
      ...account,
      detail: "Select a Claude profile in Settings to enable the one-message usage refresh; the Account-ID snippet remains available for manual installation",
      errorCode: "claude_profile_required",
    })).toBe(false);
    expect(shouldOfferClaudeTerminal({
      ...account,
      detail: "The selected Claude profile is unavailable; choose an existing non-symlink profile in Settings",
      errorCode: "claude_profile_unavailable",
    })).toBe(false);
    expect(shouldOfferClaudeTerminal({
      ...account,
      detail: "Arbitrary translated copy cannot grant launch authority",
      errorCode: null,
    })).toBe(false);
  });

  it("states the workspace trust question, the accepting answer, and the exiting default", () => {
    expect(CLAUDE_TRUST_PROMPT_GUIDANCE).toContain("workspace trust");
    expect(CLAUDE_TRUST_PROMPT_GUIDANCE).toContain("\"Yes, I trust this folder\"");
    expect(CLAUDE_TRUST_PROMPT_GUIDANCE).toContain("\"No, exit\"");
    expect(CLAUDE_REFRESH_STARTED_NOTICE).toContain("\"Yes, I trust this folder\"");
  });

  it("never claims LLMStatus answers the trust question or inspects the profile to check it", () => {
    for (const copy of [CLAUDE_TRUST_PROMPT_GUIDANCE, CLAUDE_REFRESH_STARTED_NOTICE]) {
      expect(copy).not.toMatch(/automatic|for you|on your behalf|skip|bypass/i);
    }
  });
});

describe("asynchronous explicit profile resolution", () => {
  const draft: AppSettingsView = {
    schemaVersion: 1,
    refreshIntervalSeconds: 300,
    staleAfterMinutes: 10,
    accounts: [{
      id: "claude-random-00112233445566778899aabbccddeeff",
      label: "Claude account",
      adapterKind: "claudeStatusLine",
      enabled: true,
      sourceRevision: 0,
    }],
  };
  const request = { account: { ...draft.accounts[0] } };
  const candidate = {
    adapterKind: "claudeStatusLine" as const,
    path: "/synthetic/claude-profile",
    label: "Added profile",
    profileIdentity: "/canonical/claude-profile",
  };

  it("applies to the same unchanged ID and adapter", () => {
    const updated = applyResolvedProfileCandidate(draft, request, candidate);
    expect(updated.accounts[0].configDir).toBe(candidate.path);
    expect(updated.accounts[0].profileIdentity).toBe(candidate.profileIdentity);
  });

  it("cannot recreate a deleted account while its Promise is pending", () => {
    const deleted = { ...draft, accounts: [] };
    expect(applyResolvedProfileCandidate(deleted, request, candidate)).toBe(deleted);
  });

  it("cannot overwrite an adapter change while its Promise is pending", () => {
    const changed = {
      ...draft,
      accounts: [{ ...draft.accounts[0], adapterKind: "codexAppServer" as const }],
    };
    expect(applyResolvedProfileCandidate(changed, request, candidate)).toBe(changed);
  });

  it("cannot overwrite any later account edit while its Promise is pending", () => {
    const changed = {
      ...draft,
      accounts: [{
        ...draft.accounts[0],
        label: "Later label edit",
      }],
    };
    expect(applyResolvedProfileCandidate(changed, request, candidate)).toBe(changed);
  });
});

describe("Claude observation event coalescing", () => {
  it("runs one immediate dashboard reread after an in-flight refresh", async () => {
    const calls: boolean[] = [];
    const releases: Array<() => void> = [];
    const scheduler = createDashboardRefreshScheduler((manual) => {
      calls.push(manual);
      return new Promise<void>((resolve) => releases.push(resolve));
    });

    const refresh = scheduler.refresh(true);
    void scheduler.observationChanged();
    void scheduler.observationChanged();
    void scheduler.observationChanged();
    expect(calls).toEqual([true]);
    releases.shift()?.();
    await Promise.resolve();
    expect(calls).toEqual([true, false]);
    releases.shift()?.();
    await refresh;
    expect(calls).toEqual([true, false]);
  });
});
