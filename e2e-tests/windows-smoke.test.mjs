import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const DRIVER_HOST = "127.0.0.1";
const DRIVER_PORT = 4444;
const DRIVER_URL = `http://${DRIVER_HOST}:${DRIVER_PORT}`;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const APPLICATION = resolve(
  REPOSITORY_ROOT,
  "src-tauri",
  "target",
  "debug",
  "llmstatus.exe",
);

const delay = (milliseconds) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

function waitForDriver(timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolveReady, rejectReady) => {
    const connect = () => {
      const socket = createConnection({ host: DRIVER_HOST, port: DRIVER_PORT });
      socket.once("connect", () => {
        socket.destroy();
        resolveReady();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          rejectReady(new Error("tauri-driver did not become ready within 15 seconds"));
          return;
        }
        setTimeout(connect, 200);
      });
    };
    connect();
  });
}

async function webdriver(method, path, body) {
  const response = await fetch(`${DRIVER_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    const message = payload.value?.message ?? JSON.stringify(payload);
    throw new Error(`WebDriver ${method} ${path} failed: ${message}`);
  }
  return payload.value;
}

async function findElement(sessionId, selector, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await webdriver("POST", `/session/${sessionId}/element`, {
        using: "css selector",
        value: selector,
      });
      return value[ELEMENT_KEY];
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`Element did not appear: ${selector}`, { cause: lastError });
}

async function findElements(sessionId, selector) {
  return webdriver("POST", `/session/${sessionId}/elements`, {
    using: "css selector",
    value: selector,
  });
}

async function click(sessionId, selector) {
  const elementId = await findElement(sessionId, selector);
  await webdriver("POST", `/session/${sessionId}/element/${elementId}/click`, {});
}

async function textOf(sessionId, selector) {
  const elementId = await findElement(sessionId, selector);
  return webdriver("GET", `/session/${sessionId}/element/${elementId}/text`);
}

async function replaceValue(sessionId, selector, value) {
  const elementId = await findElement(sessionId, selector);
  await webdriver("POST", `/session/${sessionId}/element/${elementId}/clear`, {});
  await webdriver("POST", `/session/${sessionId}/element/${elementId}/value`, {
    text: value,
    value: Array.from(value),
  });
}

async function executeScript(sessionId, script, args = []) {
  return webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function selectValue(sessionId, selector, value) {
  return executeScript(sessionId, `
    const element = document.querySelector(arguments[0]);
    if (!(element instanceof HTMLSelectElement)) throw new Error("select not found");
    element.value = arguments[1];
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  `, [selector, value]);
}

function withoutWindowsNamespacePrefix(path) {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function equalExceptWindowsNamespacePrefix(left, right) {
  return withoutWindowsNamespacePrefix(left) === withoutWindowsNamespacePrefix(right);
}

async function waitForProfileOptionValues(sessionId, selector, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await executeScript(sessionId, `
      const element = document.querySelector(arguments[0]);
      if (!(element instanceof HTMLSelectElement)) return null;
      const field = element.closest(".profile-field");
      const refresh = field?.querySelector(".profile-refresh-button");
      return {
        discovering: refresh instanceof HTMLButtonElement && refresh.disabled,
        values: Array.from(element.options)
          .map((option) => option.value)
          .filter((value) => value !== ""),
      };
    `, [selector]);
    if (state && !state.discovering) return state.values;
    await delay(200);
  }
  throw new Error(`Profile discovery did not finish: ${selector}`);
}

async function optionIsDisabled(sessionId, selector, value) {
  return executeScript(sessionId, `
    const element = document.querySelector(arguments[0]);
    if (!(element instanceof HTMLSelectElement)) throw new Error("select not found");
    return Array.from(element.options).find((option) => option.value === arguments[1])?.disabled ?? null;
  `, [selector, value]);
}

test("Windows WebView2 saves multiple Claude accounts with optional profiles", async () => {
  assert.equal(process.platform, "win32", "this smoke test requires Windows");
  assert.ok(existsSync(APPLICATION), `debug application is missing: ${APPLICATION}`);
  assert.ok(
    process.env.LLMSTATUS_TEST_DATA_DIR,
    "LLMSTATUS_TEST_DATA_DIR must isolate GUI test data",
  );
  const isolatedDataRoot = resolve(process.env.LLMSTATUS_TEST_DATA_DIR);
  const profilesRoot = resolve(isolatedDataRoot, "synthetic-profiles");
  const claudeProfile = resolve(profilesRoot, "ClaudeWork");
  const nestedAliasParent = resolve(profilesRoot, "nested");
  const codexProfile = resolve(profilesRoot, "CodexWork");
  const codexSymlinkAlias = resolve(profilesRoot, "codex-link");
  mkdirSync(claudeProfile, { recursive: true });
  mkdirSync(nestedAliasParent, { recursive: true });
  mkdirSync(codexProfile, { recursive: true });
  if (!existsSync(codexSymlinkAlias)) {
    symlinkSync(codexProfile, codexSymlinkAlias, "junction");
  }
  const canonicalClaudeProfile = realpathSync.native(claudeProfile);
  const canonicalCodexProfile = realpathSync.native(codexProfile);
  assert.ok(
    equalExceptWindowsNamespacePrefix(
      realpathSync.native(codexSymlinkAlias),
      canonicalCodexProfile,
    ),
    "the synthetic Codex junction must resolve to its canonical target",
  );
  process.env.CLAUDE_CONFIG_DIR = `${nestedAliasParent}\\..\\ClaudeWork`;
  process.env.CODEX_HOME = codexSymlinkAlias;

  const tauriDriver = spawn("tauri-driver", [], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let sessionId;

  try {
    await waitForDriver();
    const session = await webdriver("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          "tauri:options": { application: APPLICATION },
        },
        firstMatch: [{}],
      },
    });
    sessionId = session.sessionId;
    assert.ok(sessionId, "tauri-driver did not return a session ID");

    assert.equal(await textOf(sessionId, "h1"), "LLMStatus");
    await findElement(sessionId, '[data-testid="brand-app-icon"]');
    assert.match(await textOf(sessionId, ".onboarding"), /Add your first account/);

    await click(sessionId, '[data-testid="open-settings"]');
    assert.equal(await textOf(sessionId, "#settings-title"), "Account settings");
    await findElement(sessionId, '[data-testid="add-codex-account"]');

    await click(sessionId, '[data-testid="add-claude-account"]');
    await findElement(sessionId, '[data-testid="account-settings-0"]');
    await replaceValue(sessionId, '[data-testid="account-label-0"]', "Windows Claude");
    await findElement(sessionId, '[data-testid="account-adapter-0"]');
    await findElement(sessionId, '[data-testid="account-config-dir-0"]');
    const claudeOptionValues = await waitForProfileOptionValues(
      sessionId,
      '[data-testid="account-config-dir-0"]',
    );
    const selectedClaudePath = claudeOptionValues.find((path) =>
      equalExceptWindowsNamespacePrefix(path, canonicalClaudeProfile)
    );
    assert.equal(
      typeof selectedClaudePath,
      "string",
      "discovery must return the independently canonicalized ClaudeWork path with exact case",
    );
    assert.equal(
      withoutWindowsNamespacePrefix(selectedClaudePath),
      withoutWindowsNamespacePrefix(canonicalClaudeProfile),
      "only a Windows namespace-prefix representation difference is permitted",
    );
    assert.equal(
      await selectValue(sessionId, '[data-testid="account-config-dir-0"]', selectedClaudePath),
      selectedClaudePath,
    );
    await click(sessionId, '[data-testid="add-claude-account"]');
    await findElement(sessionId, '[data-testid="account-settings-1"]');
    await replaceValue(sessionId, '[data-testid="account-label-1"]', "Windows Claude 2");
    await findElement(sessionId, '[data-testid="account-config-dir-1"]');
    assert.equal(
      await optionIsDisabled(
        sessionId,
        '[data-testid="account-config-dir-1"]',
        selectedClaudePath,
      ),
      true,
      "the backend-issued profile identity must disable a canonical-equivalent selection",
    );

    await click(sessionId, '[data-testid="add-codex-account"]');
    await findElement(sessionId, '[data-testid="account-settings-2"]');
    const codexOptionValues = await waitForProfileOptionValues(
      sessionId,
      '[data-testid="account-config-dir-2"]',
    );
    assert.equal(
      codexOptionValues.some((path) =>
        equalExceptWindowsNamespacePrefix(path, codexSymlinkAlias)
        || equalExceptWindowsNamespacePrefix(path, canonicalCodexProfile)
      ),
      false,
      "the synthetic Codex junction and its canonical target must be excluded",
    );
    await click(sessionId, '[data-testid="account-settings-2"] .danger-button');

    await click(sessionId, '[data-testid="save-settings"]');
    const persisted = JSON.parse(readFileSync(resolve(isolatedDataRoot, "settings.json"), "utf8"));
    assert.match(persisted.accounts[0].id, /-[0-9a-f]{32}$/);
    assert.match(persisted.accounts[1].id, /-[0-9a-f]{32}$/);
    assert.notEqual(persisted.accounts[0].id, persisted.accounts[1].id);
    const cardText = await textOf(
      sessionId,
      `[data-testid="account-card-${persisted.accounts[0].id}"]`,
    );
    const secondCardText = await textOf(
      sessionId,
      `[data-testid="account-card-${persisted.accounts[1].id}"]`,
    );
    await findElement(sessionId, '[data-testid="provider-mark-anthropic"]');
    assert.match(cardText, /Windows Claude/);
    assert.match(cardText, /Waiting for Claude Code statusLine data/);
    assert.match(secondCardText, /Windows Claude 2/);
    assert.match(secondCardText, /Select a Claude profile in Settings/);
    assert.equal(
      (await findElements(sessionId, '[data-testid^="launch-claude-"]')).length,
      1,
      "only the selected usable Claude profile may offer a Terminal action",
    );
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.accounts[0].configDir, selectedClaudePath);
    assert.equal(persisted.accounts[1].configDir, undefined);
    assert.ok(
      persisted.accounts.every((account) => !("profileIdentity" in account)),
      "response-only profile identities must be stripped from persistent settings",
    );
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
    }
    tauriDriver.kill();
  }
});
