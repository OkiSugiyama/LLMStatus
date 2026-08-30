import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  effectiveLocalReleaseCaches,
  LOCAL_RELEASE_COMMANDS,
  LOCAL_RELEASE_ENVIRONMENT,
  localReleaseEnvironment,
} from "../scripts/local-release-check.mjs";

test("local release check uses only fixed local commands", () => {
  assert.deepEqual(LOCAL_RELEASE_COMMANDS[0], ["npm", "ci", "--offline"]);
  assert.ok(LOCAL_RELEASE_COMMANDS.some((command) => command.join(" ") === "npm audit --offline"));
  assert.ok(
    LOCAL_RELEASE_COMMANDS.some(
      (command) => command.join(" ") === "node scripts/release-tree.mjs verify-determinism",
    ),
  );
  assert.ok(
    LOCAL_RELEASE_COMMANDS.some(
      (command) => command.join(" ") === "node scripts/release-tree.mjs assert-no-workflows",
    ),
  );
  assert.ok(
    LOCAL_RELEASE_COMMANDS.some(
      (command) => command.join(" ") === "node scripts/release-tree.mjs scan-repository-secrets",
    ),
  );
  assert.deepEqual(LOCAL_RELEASE_ENVIRONMENT, { CARGO_NET_OFFLINE: "true" });
  assert.deepEqual(localReleaseEnvironment({ CARGO_NET_OFFLINE: "false", SENTINEL: "kept" }), {
    CARGO_NET_OFFLINE: "true",
    SENTINEL: "kept",
  });
  const caches = effectiveLocalReleaseCaches(
    { CARGO_HOME: "/var/tmp/cargo-home" },
    "/var/tmp/npm-cache\n",
    "/home/tester",
  );
  assert.deepEqual(caches, {
    npmCacheDirectory: "/var/tmp/npm-cache",
    cargoHome: "/var/tmp/cargo-home",
  });
  assert.deepEqual(localReleaseEnvironment({ SENTINEL: "kept" }, caches), {
    CARGO_HOME: "/var/tmp/cargo-home",
    CARGO_NET_OFFLINE: "true",
    SENTINEL: "kept",
    npm_config_cache: "/var/tmp/npm-cache",
  });
  const windowsLookingHome = "C:\\Users\\tester";
  assert.deepEqual(effectiveLocalReleaseCaches({}, "C:\\npm-cache", windowsLookingHome), {
    npmCacheDirectory: "C:\\npm-cache",
    cargoHome: join(windowsLookingHome, ".cargo"),
  });
  for (const command of LOCAL_RELEASE_COMMANDS.filter(
    ([executable, ...args]) => executable === "cargo" || args.includes("tauri:build"),
  )) {
    assert.equal(LOCAL_RELEASE_ENVIRONMENT.CARGO_NET_OFFLINE, "true", command.join(" "));
  }
  const serialized = JSON.stringify(LOCAL_RELEASE_COMMANDS);
  assert.doesNotMatch(serialized, /curl|wget|powershell|osascript|publish|push|release create/i);
});
