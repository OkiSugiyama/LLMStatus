import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");

export const LOCAL_RELEASE_COMMANDS = Object.freeze([
  Object.freeze(["npm", "ci", "--offline"]),
  Object.freeze(["npm", "run", "check"]),
  Object.freeze([
    "node",
    "--test",
    "e2e-tests/release-dependency-notices.test.mjs",
    "e2e-tests/release-local-check.test.mjs",
    "e2e-tests/release-tree.test.mjs",
  ]),
  Object.freeze(["cargo", "fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"]),
  Object.freeze(["cargo", "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets"]),
  Object.freeze([
    "cargo",
    "clippy",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]),
  Object.freeze(["npm", "run", "tauri:build", "--", "--debug", "--no-bundle"]),
  Object.freeze(["npm", "audit", "--offline"]),
  Object.freeze(["node", "scripts/release-tree.mjs", "assert-no-workflows"]),
  Object.freeze(["node", "scripts/release-tree.mjs", "scan-repository-secrets"]),
  Object.freeze(["node", "scripts/dependency-notices.mjs", "verify"]),
  Object.freeze(["node", "scripts/release-tree.mjs", "validate"]),
  Object.freeze(["node", "scripts/release-tree.mjs", "verify-determinism"]),
  Object.freeze(["git", "diff", "--check"]),
]);

export const LOCAL_RELEASE_ENVIRONMENT = Object.freeze({ CARGO_NET_OFFLINE: "true" });

export function localReleaseEnvironment(baseEnvironment = {}, cacheEnvironment = {}) {
  const environment = { ...baseEnvironment, ...LOCAL_RELEASE_ENVIRONMENT };
  if (cacheEnvironment.npmCacheDirectory) environment.npm_config_cache = cacheEnvironment.npmCacheDirectory;
  if (cacheEnvironment.cargoHome) environment.CARGO_HOME = cacheEnvironment.cargoHome;
  return environment;
}

export function effectiveLocalReleaseCaches(
  baseEnvironment = process.env,
  npmCacheDirectory,
  homeDirectory = homedir(),
) {
  const npmCache = npmCacheDirectory?.trim();
  if (!npmCache) throw new Error("npm effective cache directory is unavailable");
  const cargoHome = baseEnvironment.CARGO_HOME?.trim() || join(homeDirectory, ".cargo");
  return { npmCacheDirectory: npmCache, cargoHome };
}

function assertCleanTrackedCheckout() {
  execFileSync("git", ["diff", "--quiet"], { cwd: ROOT, stdio: "ignore" });
  execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT, stdio: "ignore" });
}

function run() {
  assertCleanTrackedCheckout();
  const npmCacheDirectory = execFileSync("npm", ["config", "get", "cache"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cacheEnvironment = effectiveLocalReleaseCaches(process.env, npmCacheDirectory);
  const childEnvironment = localReleaseEnvironment(process.env, cacheEnvironment);
  process.stdout.write(
    `Using npm cache selected by effective npm configuration and Cargo archives selected by effective CARGO_HOME.\n`,
  );
  for (const [executable, ...args] of LOCAL_RELEASE_COMMANDS) {
    process.stdout.write(`\n$ ${[executable, ...args].join(" ")}\n`);
    const result = spawnSync(executable, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnvironment,
      shell: false,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${executable} exited ${result.status ?? "without a status"}`);
    }
  }
  process.stdout.write(
    "\nLocal source checks passed. This does not establish a fresh Rust advisory result, Windows runtime behavior, physical behavior, bundle contents, signing, notarization, or publication readiness.\n",
  );
}

function main() {
  const action = process.argv[2];
  if (action === "commands") {
    process.stdout.write(`${JSON.stringify(LOCAL_RELEASE_COMMANDS)}\n`);
  } else if (action === "run") {
    run();
  } else {
    throw new Error("usage: node scripts/local-release-check.mjs <commands|run>");
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
