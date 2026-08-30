import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_CLASSIFICATION = "docs/release/public-tree.json";
const MANIFEST_NAME = "SOURCE-MANIFEST.json";

const REQUIRED_PUBLIC_RULES = [
  ["file", ".gitignore"],
  ["file", "CONTRIBUTING.md"],
  ["file", "LICENSE"],
  ["file", "README.md"],
  ["file", "SECURITY.md"],
  ["file", "THIRD_PARTY_LICENSES.md"],
  ["file", "THIRD_PARTY_NOTICES.md"],
  ["prefix", "docs/release/"],
  ["file", "docs/architecture.md"],
  ["file", "docs/macos-physical-smoke.md"],
  ["file", "docs/windows-physical-smoke.md"],
  ["prefix", "e2e-tests/"],
  ["file", "index.html"],
  ["file", "package-lock.json"],
  ["file", "package.json"],
  ["prefix", "scripts/"],
  ["file", "src-tauri/Cargo.lock"],
  ["file", "src-tauri/Cargo.toml"],
  ["file", "src-tauri/Info.plist"],
  ["file", "src-tauri/app-icon.svg"],
  ["file", "src-tauri/build.rs"],
  ["prefix", "src-tauri/capabilities/"],
  ["prefix", "src-tauri/icons/"],
  ["prefix", "src-tauri/src/"],
  ["file", "src-tauri/tauri.conf.json"],
  ["file", "src-tauri/tauri.e2e.conf.json"],
  ["prefix", "src/"],
  ["file", "tsconfig.app.json"],
  ["file", "tsconfig.json"],
  ["file", "tsconfig.node.json"],
  ["file", "vite.config.ts"],
];

const REQUIRED_EXCLUDED_RULES = [
  ["file", "AGENTS.md"],
  ["file", "docs/DEFINITION-OF-DONE.md"],
  ["prefix", encoded(["docs/", "handoffs/"])],
  ["file", encoded(["docs/", "project", "-status.md"])],
  ["file", "docs/project.yaml"],
  ["prefix", encoded(["docs/", "qa/"])],
  ["prefix", encoded(["docs/", "tasks/"])],
  ["prefix", "src-tauri/gen/"],
];

const FORBIDDEN_PUBLIC_PATHS = [
  "AGENTS.md",
  "docs/DEFINITION-OF-DONE.md",
  encoded(["docs/", "handoffs/", "example.md"]),
  encoded(["docs/", "project", "-status.md"]),
  "docs/project.yaml",
  encoded(["docs/", "qa/", "example.md"]),
  encoded(["docs/", "tasks/", "example.md"]),
  "src-tauri/gen/example.json",
];

function command(root, executable, args) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function assertSafeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path)
  ) {
    throw new Error(`unsafe path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe path: ${JSON.stringify(path)}`);
  }
  return path;
}

function validateRule(rule, group) {
  if (!rule || !["file", "prefix"].includes(rule.kind)) {
    throw new Error(`${group} has an invalid rule kind`);
  }
  if (rule.kind === "prefix" && !rule.path.endsWith("/")) {
    throw new Error(`${group} prefix must end with /: ${rule.path}`);
  }
  const path = rule.kind === "prefix" ? rule.path.slice(0, -1) : rule.path;
  assertSafeRelativePath(path);
  return rule;
}

function ruleMatches(path, rule) {
  return rule.kind === "file" ? path === rule.path : path.startsWith(rule.path);
}

export function classifyTrackedPaths(paths, classification) {
  if (classification?.schemaVersion !== 1) {
    throw new Error("public-tree classification schemaVersion must be 1");
  }
  const groups = [
    ["public", classification.public],
    ["excluded", classification.excluded],
  ];
  for (const [name, rules] of groups) {
    if (!Array.isArray(rules)) throw new Error(`${name} rules must be an array`);
    rules.forEach((rule) => validateRule(rule, name));
  }
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length !== paths.length) throw new Error("tracked paths contain duplicates");
  const result = { public: [], excluded: [] };
  for (const path of uniquePaths) {
    assertSafeRelativePath(path);
    const matches = groups.flatMap(([group, rules]) =>
      rules.filter((rule) => ruleMatches(path, rule)).map((rule) => ({ group, rule })),
    );
    if (matches.length === 0) throw new Error(`unclassified tracked path: ${path}`);
    if (matches.length !== 1) throw new Error(`multiply classified tracked path: ${path}`);
    result[matches[0].group].push(path);
  }
  return result;
}

function hasExactRule(rules, kind, path) {
  return rules.some((rule) => rule.kind === kind && rule.path === path);
}

export function assertRequiredClassification(classification, tracked, classified) {
  for (const [kind, path] of REQUIRED_PUBLIC_RULES) {
    if (!hasExactRule(classification.public, kind, path)) {
      throw new Error(`required public classification rule missing: ${kind}:${path}`);
    }
  }
  for (const [kind, path] of REQUIRED_EXCLUDED_RULES) {
    if (!hasExactRule(classification.excluded, kind, path)) {
      throw new Error(`required excluded classification rule missing: ${kind}:${path}`);
    }
  }
  for (const path of FORBIDDEN_PUBLIC_PATHS) {
    if (classification.public.some((rule) => ruleMatches(path, rule))) {
      throw new Error(`internal path can be classified public: ${path}`);
    }
  }
  const workflows = tracked.filter((path) => path.startsWith(".github/workflows/"));
  if (workflows.length > 0) throw new Error(`tracked hosted workflow path: ${workflows.join(", ")}`);
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.md"]) {
    if (!classified.public.includes(path)) throw new Error(`required public file missing: ${path}`);
  }
  for (const path of classified.excluded) {
    if (classified.public.includes(path)) throw new Error(`path appears in both dispositions: ${path}`);
  }
}

function readClassification(root, path = DEFAULT_CLASSIFICATION) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function trackedPaths(root) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.toString("utf8").split("\0").filter(Boolean).sort();
}

function assertCleanTrackedCheckout(root) {
  execFileSync("git", ["diff", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root, stdio: "ignore" });
}

function ensureContained(root, path) {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`path escapes root: ${path}`);
  return absolute;
}

function listFiles(root, prefix = "") {
  const directory = ensureContained(root, prefix || ".");
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symbolic link in export: ${path}`);
    if (entry.isDirectory()) result.push(...listFiles(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`unsupported export entry: ${path}`);
  }
  return result.sort();
}

function encoded(words) {
  return words.join("");
}

const YAML_KEY_BOUNDARY = "(?:^|[\\n{,])";
const YAML_KEY_PROPERTIES = "(?:(?:[&!][^\\s]+)\\s+)*";

function hostedMappingKeyPattern(keyPattern) {
  return new RegExp(
    encoded([
      YAML_KEY_BOUNDARY,
      "\\s*(?:\\?\\s*)?",
      YAML_KEY_PROPERTIES,
      "[\"']?(?:",
      keyPattern,
      ")[\"']?\\s*:",
    ]),
    "i",
  );
}

const HOSTED_ALIAS_KEY_PATTERN = new RegExp(
  encoded([
    YAML_KEY_BOUNDARY,
    "\\s*(?:\\?\\s*)?",
    YAML_KEY_PROPERTIES,
    "\\*[A-Za-z0-9_.-]+\\s*:",
  ]),
  "i",
);

const HOSTED_PATTERNS = [
  hostedMappingKeyPattern(encoded(["runs", "-on"])),
  hostedMappingKeyPattern("on"),
  hostedMappingKeyPattern(
    encoded([
      "push",
      "|",
      "pull",
      "_request(?:_target)?|",
      "schedule",
      "|",
      "workflow",
      "_(?:dispatch|call|run)|",
      "repository",
      "_dispatch",
    ]),
  ),
  HOSTED_ALIAS_KEY_PATTERN,
  new RegExp(encoded(["workflow", "_dispatch", "\\s*:"]), "i"),
  new RegExp(encoded(["workflow", "_call", "\\s*:"]), "i"),
  new RegExp(encoded(["workflow", "_run", "\\s*:"]), "i"),
  new RegExp(encoded(["pull", "_request(?:_target)?", "\\s*:"]), "i"),
  new RegExp(encoded(["repository", "_dispatch", "\\s*:"]), "i"),
  new RegExp(encoded(["(?:^|\\n)\\s*", "push", "\\s*:"]), "i"),
  new RegExp(encoded(["(?:^|\\n)\\s*", "schedule", "\\s*:"]), "i"),
  new RegExp(
    encoded([
      "(?:^|[\\n{,])\\s*[\"']?",
      "on",
      "[\"']?\\s*:\\s*\\[[^\\]]*\\b(?:",
      "push",
      "|",
      "pull",
      "_request(?:_target)?|",
      "schedule",
      "|",
      "workflow",
      "_(?:dispatch|call|run)|",
      "repository",
      "_dispatch)\\b",
    ]),
    "i",
  ),
  hostedMappingKeyPattern("uses"),
  new RegExp(encoded(["github", "-hosted"]), "i"),
];
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
];
const PERSONAL_PATTERNS = [
  new RegExp(`/Users/${["oki", "sugiyama"].join("")}/`, "i"),
  new RegExp(`[A-Za-z]:\\\\Users\\\\${["oki", "sugiyama"].join("")}\\\\`, "i"),
  /\/Documents\/(?:Dev|cloudHead)(?:\/|\\)/i,
];
const DEVELOPMENT_PATTERNS = [
  new RegExp(encoded(["LLMStatus", "-dev"]), "i"),
  new RegExp(encoded(["docs/", "project-status"]), "i"),
];
const INTERNAL_PATTERNS = [
  new RegExp(encoded(["TASK", "-[0-9]{2}"])),
  new RegExp(encoded(["Gate", " [A-D]"]), "i"),
  new RegExp(encoded(["fresh", "-context (?:QA|security)"]), "i"),
  new RegExp(encoded(["docs/", "(?:tasks|handoffs|qa)/"]), "i"),
];

function decodedViews(bytes) {
  const views = [{ encoding: "ASCII", text: bytes.toString("latin1") }];
  for (const offset of [0, 1]) {
    if (bytes.length - offset < 2) continue;
    const evenLength = (bytes.length - offset) & ~1;
    const source = bytes.subarray(offset, offset + evenLength);
    views.push({ encoding: `UTF-16LE@${offset}`, text: source.toString("utf16le") });
    const swapped = Buffer.allocUnsafe(source.length);
    for (let index = 0; index < source.length; index += 2) {
      swapped[index] = source[index + 1];
      swapped[index + 1] = source[index];
    }
    views.push({ encoding: `UTF-16BE@${offset}`, text: swapped.toString("utf16le") });
  }
  return views;
}

function normalizeQuotedScalarEscapes(text) {
  return text.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/g, (source, short, medium, long) => {
    const codePoint = Number.parseInt(short ?? medium ?? long, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return source;
    return String.fromCodePoint(codePoint);
  });
}

function normalizeDoubleQuotedLineContinuations(text) {
  let normalized = "";
  let inDoubleQuotedScalar = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!inDoubleQuotedScalar) {
      normalized += character;
      if (character === '"') inDoubleQuotedScalar = true;
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      let afterBreak;
      if (next === "\n") afterBreak = index + 2;
      else if (next === "\r" && text[index + 2] === "\n") afterBreak = index + 3;
      else if (next === "\r") afterBreak = index + 2;
      if (afterBreak !== undefined) {
        while (text[afterBreak] === " " || text[afterBreak] === "\t") afterBreak += 1;
        index = afterBreak - 1;
        continue;
      }
      normalized += character;
      if (next !== undefined) {
        normalized += next;
        index += 1;
      }
      continue;
    }
    normalized += character;
    if (character === '"') inDoubleQuotedScalar = false;
  }
  return normalized;
}

export function scanText(path, text, { classificationPath = DEFAULT_CLASSIFICATION, secretsOnly = false } = {}) {
  const problems = [];
  if (!secretsOnly) {
    const normalized = normalizeQuotedScalarEscapes(normalizeDoubleQuotedLineContinuations(text));
    for (const pattern of HOSTED_PATTERNS) {
      if (pattern.test(text) || (normalized !== text && pattern.test(normalized))) {
        problems.push(`${path}: forbidden content ${pattern}`);
      }
    }
  }
  const always = secretsOnly ? SECRET_PATTERNS : [...SECRET_PATTERNS, ...PERSONAL_PATTERNS];
  for (const pattern of always) {
    if (pattern.test(text)) problems.push(`${path}: forbidden content ${pattern}`);
  }
  if (!secretsOnly && path !== classificationPath) {
    for (const pattern of DEVELOPMENT_PATTERNS) {
      if (pattern.test(text)) problems.push(`${path}: private development reference ${pattern}`);
    }
    for (const pattern of INTERNAL_PATTERNS) {
      if (pattern.test(text)) problems.push(`${path}: internal delivery language ${pattern}`);
    }
  }
  return problems;
}

export function scanBytes(path, bytes, options = {}) {
  const problems = [];
  for (const view of decodedViews(bytes)) {
    for (const problem of scanText(path, view.text, options)) problems.push(`${problem} [${view.encoding}]`);
  }
  return [...new Set(problems)];
}

export function scanExport(root, options = {}) {
  root = resolve(root);
  const files = listFiles(root);
  if (files.some((path) => path === ".git" || path.startsWith(".git/"))) {
    throw new Error("export contains Git administration data");
  }
  const problems = files.flatMap((path) => scanBytes(path, readFileSync(join(root, path)), options));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return files;
}

export function scanTrackedSecrets(root, paths = trackedPaths(root)) {
  root = resolve(root);
  const problems = [];
  for (const path of paths) {
    const absolute = ensureContained(root, path);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`tracked path cannot be scanned as a regular file: ${path}`);
    }
    problems.push(...scanBytes(path, readFileSync(absolute), { secretsOnly: true }));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return paths.length;
}

export function assertNoWorkflowPaths(paths) {
  const workflows = paths.filter((path) => path.startsWith(".github/workflows/"));
  if (workflows.length > 0) throw new Error(`tracked hosted workflow path: ${workflows.join(", ")}`);
  return paths.length;
}

export function exportPublicTree({ sourceRoot, destinationRoot, paths, classification }) {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    throw new Error("export destination must be outside the source tree");
  }
  mkdirSync(destination, { recursive: false });
  const classified = classifyTrackedPaths(paths, classification);
  for (const path of classified.public) {
    const sourcePath = ensureContained(source, path);
    const destinationPath = ensureContained(destination, path);
    const metadata = lstatSync(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error(`tracked symbolic link is not exportable: ${path}`);
    if (!metadata.isFile()) throw new Error(`tracked path is not a regular file: ${path}`);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
  return classified;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createManifest(root, revision) {
  const files = listFiles(root).filter((path) => path !== MANIFEST_NAME);
  const entries = files.map((path) => ({ path, size: statSync(join(root, path)).size, sha256: hashFile(join(root, path)) }));
  const manifest = `${JSON.stringify({ schemaVersion: 1, sourceRevision: revision, files: entries }, null, 2)}\n`;
  writeFileSync(join(root, MANIFEST_NAME), manifest, { flag: "wx" });
  return manifest;
}

export function withDisposableDirectory(label, operation, temporaryRoot = tmpdir()) {
  const parent = mkdtempSync(join(temporaryRoot, `llmstatus-${label}-`));
  try {
    return operation(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function validateResult(root) {
  assertCleanTrackedCheckout(root);
  let result;
  withDisposableDirectory("release-validate", (parent) => {
    const destination = join(parent, "public-tree");
    const classification = readClassification(root);
    const paths = trackedPaths(root);
    const classified = exportPublicTree({ sourceRoot: root, destinationRoot: destination, paths, classification });
    assertRequiredClassification(classification, paths, classified);
    const manifest = createManifest(destination, command(root, "git", ["rev-parse", "HEAD"]));
    scanExport(destination);
    result = {
      publicFiles: classified.public.length,
      excludedFiles: classified.excluded.length,
      sourceRevision: JSON.parse(manifest).sourceRevision,
    };
  });
  return result;
}

function verifyDeterminism(root) {
  assertCleanTrackedCheckout(root);
  let result;
  withDisposableDirectory("release-determinism", (parent) => {
    const make = () => {
      const exportParent = mkdtempSync(join(parent, "independent-export-"));
      const destination = join(exportParent, "public-tree");
      const classification = readClassification(root);
      const paths = trackedPaths(root);
      const classified = exportPublicTree({ sourceRoot: root, destinationRoot: destination, paths, classification });
      assertRequiredClassification(classification, paths, classified);
      const manifest = createManifest(destination, command(root, "git", ["rev-parse", "HEAD"]));
      scanExport(destination);
      return { destination, manifest };
    };
    const first = make();
    const second = make();
    if (first.manifest !== second.manifest) throw new Error("independent source manifests differ");
    const firstFiles = listFiles(first.destination);
    const secondFiles = listFiles(second.destination);
    if (JSON.stringify(firstFiles) !== JSON.stringify(secondFiles)) {
      throw new Error("independent public file lists differ");
    }
    for (const path of firstFiles) {
      if (hashFile(join(first.destination, path)) !== hashFile(join(second.destination, path))) {
        throw new Error(`independent export hash differs: ${path}`);
      }
    }
    result = {
      files: firstFiles.length,
      manifestSha256: createHash("sha256").update(first.manifest).digest("hex"),
    };
  });
  return result;
}

function main() {
  const action = process.argv[2];
  const allowed = new Set(["validate", "verify-determinism", "assert-no-workflows", "scan-repository-secrets"]);
  if (!allowed.has(action)) {
    throw new Error(`usage: node scripts/release-tree.mjs <${[...allowed].join("|")}>`);
  }
  const root = command(DEFAULT_ROOT, "git", ["rev-parse", "--show-toplevel"]);
  let result;
  if (action === "validate") result = validateResult(root);
  else if (action === "verify-determinism") result = verifyDeterminism(root);
  else if (action === "assert-no-workflows") result = { trackedFiles: assertNoWorkflowPaths(trackedPaths(root)) };
  else result = { scannedFiles: scanTrackedSecrets(root) };
  process.stdout.write(`${JSON.stringify({ action, ...result })}\n`);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
