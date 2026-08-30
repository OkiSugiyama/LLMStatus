import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNoWorkflowPaths,
  assertRequiredClassification,
  assertSafeRelativePath,
  classifyTrackedPaths,
  exportPublicTree,
  scanExport,
  scanTrackedSecrets,
  withDisposableDirectory,
} from "../scripts/release-tree.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixture = {
  schemaVersion: 1,
  public: [{ kind: "prefix", path: "public/" }],
  excluded: [{ kind: "prefix", path: "internal/" }],
};

function actualTrackedPaths() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

test("classification requires exactly one disposition for every tracked path", () => {
  assert.deepEqual(classifyTrackedPaths(["public/app.ts", "internal/report.md"], fixture), {
    public: ["public/app.ts"],
    excluded: ["internal/report.md"],
  });
  assert.throws(() => classifyTrackedPaths(["new/file.txt"], fixture), /unclassified tracked path/);
  assert.throws(
    () =>
      classifyTrackedPaths(["public/app.ts"], {
        ...fixture,
        excluded: [{ kind: "file", path: "public/app.ts" }],
      }),
    /multiply classified tracked path/,
  );
});

test("actual classification has mandatory public and excluded dispositions", () => {
  const classification = JSON.parse(readFileSync(join(ROOT, "docs/release/public-tree.json"), "utf8"));
  const tracked = actualTrackedPaths();
  const classified = classifyTrackedPaths(tracked, classification);
  assert.doesNotThrow(() => assertRequiredClassification(classification, tracked, classified));

  const missingPublic = {
    ...classification,
    public: classification.public.filter((rule) => rule.path !== "LICENSE"),
  };
  assert.throws(
    () => assertRequiredClassification(missingPublic, tracked, classified),
    /required public classification rule missing/,
  );

  const exposedInternal = {
    ...classification,
    public: [...classification.public, { kind: "file", path: "AGENTS.md" }],
    excluded: classification.excluded.filter((rule) => rule.path !== "AGENTS.md"),
  };
  const exposedClassified = classifyTrackedPaths(tracked, exposedInternal);
  assert.throws(
    () => assertRequiredClassification(exposedInternal, tracked, exposedClassified),
    /required excluded classification rule missing|internal path can be classified public/,
  );
  assert.throws(
    () => assertNoWorkflowPaths([...tracked, ".github/workflows/ci.yml"]),
    /tracked hosted workflow path/,
  );
});

test("path validation rejects traversal and absolute paths", () => {
  for (const path of ["../outside", "nested/../outside", "/absolute", "C:\\absolute", "a\\b"]) {
    assert.throws(() => assertSafeRelativePath(path), /unsafe path/);
  }
});

test("export rejects a tracked symbolic link", () => {
  const root = mkdtempSync(join(tmpdir(), "llmstatus-release-symlink-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  try {
    mkdirSync(join(source, "public"), { recursive: true });
    writeFileSync(join(source, "target"), "safe\n");
    symlinkSync(join(source, "target"), join(source, "public", "link"));
    assert.throws(
      () =>
        exportPublicTree({
          sourceRoot: source,
          destinationRoot: destination,
          paths: ["public/link"],
          classification: fixture,
        }),
      /symbolic link/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner rejects hosted trigger forms regardless of file name", () => {
  const onKey = ["o", "n"].join("");
  const runnerKey = ["runs", "-on"].join("");
  const usesKey = ["us", "es"].join("");
  const pullRequestEvent = ["pull", "_request"].join("");
  const events = [
    "push",
    "pull_request",
    "pull_request_target",
    "schedule",
    "workflow_dispatch",
    "workflow_call",
    "workflow_run",
    "repository_dispatch",
  ];
  const cases = [
    ["renamed.yml", `${["workflow", "_dispatch"].join("")}:\n${["runs", "-on"].join("")}: machine\n`],
    ["renamed.yaml", `${["on", ": [", "push", "]"].join("")}\n`],
    ["pull-request-array.txt", `${["on", ": [", "pull", "_request", "]"].join("")}\n`],
    ["pull-request-target-array.txt", `${["on", ": [", "pull", "_request_target", "]"].join("")}\n`],
    ["schedule-array.txt", `${["on", ": [", "schedule", "]"].join("")}\n`],
    ["dispatch-array.txt", `${["on", ": [", "repository", "_dispatch", "]"].join("")}\n`],
    ["workflow-dispatch-array.txt", `${["on", ": [", "workflow", "_dispatch", "]"].join("")}\n`],
    ["workflow-call-array.txt", `${["on", ": [", "workflow", "_call", "]"].join("")}\n`],
    ["workflow-run-array.txt", `${["on", ": [", "workflow", "_run", "]"].join("")}\n`],
    [
      "reusable-job.txt",
      `${["on", ": [", "pull", "_request", "]"].join("")}\n${["jobs", ":\n  verify:\n    ", "uses", ": owner/repository/.github/workflows/reusable.yml@v1"].join("")}\n`,
    ],
    ["configuration.bin", `${["schedule", ":"].join("")}\n`],
    ["extensionless", `${["workflow", "_run", ":"].join("")}\n`],
    ["quoted-on.txt", `${["\"", "on", "\"", ": [issues]"].join("")}\n`],
    [
      "inline-reusable.txt",
      `${["jobs", ": { call: { ", "uses", ": owner/repository/.github/workflows/reusable.yml@v1 } }"].join("")}\n`,
    ],
    [
      "quoted-reusable.txt",
      `${["jobs", ":\n  call:\n    \"", "uses", "\": owner/repository/.github/workflows/reusable.yml@v1"].join("")}\n`,
    ],
    [
      "single-quoted-reusable.txt",
      `${["jobs", ": { call: { '", "uses", "': owner/repository/.github/workflows/reusable.yml@v1 } }"].join("")}\n`,
    ],
  ];
  const flowMapTemplates = [
    (event) => `{${onKey}:[${event}]}\n`,
    (event) => `{seed:true,${onKey}:[${event}]}\n`,
    (event) => `{"${onKey}":["${event}"]}\n`,
    (event) => `{"seed":true,"${onKey}":["${event}"]}\n`,
    (event) => `{'seed':true,'${onKey}':['${event}']}\n`,
    (event) => `{"${event}":{}}\n`,
    (event) => `{seed:{},'${event}':{}}\n`,
  ];
  const lineBlockTemplates = [
    (event) => `${onKey}: [${event}]\n`,
    (event) => `${onKey}:\n  - ${event}\n`,
    (event) => `"${onKey}": [${event}]\n`,
    (event) => `'${onKey}': [${event}]\n`,
    (event) => `${onKey}:\n  "${event}": {}\n`,
    (event) => `${onKey}:\n  '${event}': {}\n`,
  ];
  assert.equal(events.length * lineBlockTemplates.length, 48);
  assert.equal(events.length * flowMapTemplates.length, 56);
  for (const event of events) {
    for (const [index, template] of lineBlockTemplates.entries()) {
      cases.push([`line-block-${event}-${index}.txt`, template(event)]);
    }
    for (const [index, template] of flowMapTemplates.entries()) {
      cases.push([`flow-map-${event}-${index}.txt`, template(event)]);
    }
  }
  const reusableTemplates = [
    `${usesKey}: owner/repository/.github/workflows/reusable.yml@v1\n`,
    `{${usesKey}: owner/repository/.github/workflows/reusable.yml@v1}\n`,
    `"${usesKey}": owner/repository/.github/workflows/reusable.yml@v1\n`,
    `{"${usesKey}":"owner/repository/.github/workflows/reusable.yml@v1"}\n`,
    `'${usesKey}': owner/repository/.github/workflows/reusable.yml@v1\n`,
    `{'${usesKey}':'owner/repository/.github/workflows/reusable.yml@v1'}\n`,
  ];
  assert.equal(reusableTemplates.length, 6);
  reusableTemplates.forEach((content, index) => cases.push([`reusable-matrix-${index}.txt`, content]));

  const runnerTemplates = [
    ["bare-runner-line.txt", `${runnerKey}: ubuntu-latest\n`],
    ["bare-runner-flow.txt", `{${runnerKey}:ubuntu-latest}\n`],
    ["double-quoted-runner-line.txt", `"${runnerKey}": ubuntu-latest\n`],
    ["single-quoted-runner-line.txt", `'${runnerKey}': ubuntu-latest\n`],
    ["double-quoted-runner-flow.txt", `{"${runnerKey}":"ubuntu-latest"}\n`],
    ["single-quoted-runner-flow.txt", `{'${runnerKey}':'ubuntu-latest'}\n`],
  ];
  assert.equal(runnerTemplates.length, 6);
  cases.push(...runnerTemplates);

  const doubleQuotedWorkflow = `{"${onKey}":"${pullRequestEvent}","jobs":{"test":{"${runnerKey}":"ubuntu-latest","steps":[]}}}\n`;
  const singleQuotedWorkflow = `{'${onKey}':'${pullRequestEvent}','jobs':{'test':{'${runnerKey}':'ubuntu-latest','steps':[]}}}\n`;
  const completeWorkflows = [
    ["complete-double-quoted-flow.json", doubleQuotedWorkflow],
    ["complete-single-quoted-flow.yaml", singleQuotedWorkflow],
  ];
  assert.equal(completeWorkflows.length, 2);
  cases.push(...completeWorkflows);
  const encodedWorkflows = [
    [
      "complete-flow-binary.bin",
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from("\n"), Buffer.from(doubleQuotedWorkflow)]),
    ],
    ["complete-flow-utf16le.bin", Buffer.from(`# synthetic fixture\n${doubleQuotedWorkflow}`, "utf16le")],
    ["complete-flow-utf16be.bin", Buffer.from(doubleQuotedWorkflow, "utf16le").swap16()],
    ["complete-flow-nul-suffixed.bin", Buffer.concat([Buffer.from(doubleQuotedWorkflow), Buffer.from([0])])],
  ];
  assert.equal(encodedWorkflows.length, 4);
  cases.push(...encodedWorkflows);
  for (const [name, content] of cases) {
    const root = mkdtempSync(join(tmpdir(), "llmstatus-release-trigger-"));
    try {
      writeFileSync(join(root, name), content);
      assert.throws(() => scanExport(root), /forbidden content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("scanner normalizes semantic workflow keys and preserves benign neighbors", () => {
  const onKey = ["o", "n"].join("");
  const runnerKey = ["runs", "-on"].join("");
  const usesKey = ["us", "es"].join("");
  const pullRequestEvent = ["pull", "_request"].join("");
  const scalarEscape = (kind, digits) => `${String.fromCharCode(92)}${kind}${digits}`;
  const escapedOn = `${scalarEscape("u", "006f")}${scalarEscape("u", "006e")}`;
  const escapedRunner = `${scalarEscape("u", "0072")}uns-on`;
  const escapedUses = `${scalarEscape("u", "0075")}ses`;
  const triggerAlias = ["*", "trigger"].join("");
  const lineContinuation = String.fromCharCode(92);
  const escapedRunnerWorkflow = `{"${escapedOn}":"${pullRequestEvent}","jobs":{"test":{"${escapedRunner}":"ubuntu-latest","steps":[]}}}\n`;
  const escapedReusableWorkflow = `{"${escapedOn}":"workflow_call","jobs":{"call":{"${escapedUses}":"owner/repository/.github/workflows/reusable.yml@v1"}}}\n`;

  const hostileCases = [
    ["escaped-runner.json", escapedRunnerWorkflow],
    ["escaped-reusable.json", escapedReusableWorkflow],
    ["continued-on.yaml", `"o${lineContinuation}\n  n": [${pullRequestEvent}]\n`],
    [
      "continued-uses.yaml",
      `jobs:\r\n  call:\r\n    "us${lineContinuation}\r\n      es": owner/repository/.github/workflows/reusable.yml@v1\r\n`,
    ],
    ["explicit-on.yaml", `? ${onKey}\n: [${pullRequestEvent}]\n`],
    ["explicit-runner.yaml", `? "${runnerKey}"\n: ubuntu-latest\n`],
    ["explicit-uses.yaml", `? '${usesKey}'\n: owner/repository/.github/workflows/reusable.yml@v1\n`],
    ["explicit-folded-on.yaml", `? >-\n  ${onKey}\n: ${pullRequestEvent}\njobs: {}\n`],
    ["anchored-on.yaml", `&trigger ${onKey}: [${pullRequestEvent}]\n`],
    ["anchored-runner.yaml", `jobs:\n  &runner ${runnerKey}: ubuntu-latest\n`],
    ["anchored-uses.yaml", `{seed:true,&reuse ${usesKey}: owner/repository/.github/workflows/reusable.yml@v1}\n`],
    ["tagged-on.yaml", `{!trigger ${onKey}: [${pullRequestEvent}]}\n`],
    ["tagged-runner.yaml", `jobs:\n  !!str ${runnerKey}: ubuntu-latest\n`],
    ["tagged-uses.yaml", `{seed:true,!reuse ${usesKey}: owner/repository/.github/workflows/reusable.yml@v1}\n`],
    ["aliased-on.yaml", `definition: &trigger ${onKey}\n${triggerAlias}: ${pullRequestEvent}\njobs: {}\n`],
    ["yaml-hex-on.yaml", `"${scalarEscape("x", "6f")}${scalarEscape("x", "6e")}": [${pullRequestEvent}]\n`],
    ["yaml-long-runner.yaml", `"${scalarEscape("U", "00000072")}uns-on": ubuntu-latest\n`],
    ["yaml-short-uses.yaml", `"${escapedUses}": owner/repository/.github/workflows/reusable.yml@v1\n`],
    [
      "escaped-workflow-binary.bin",
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from("\n"), Buffer.from(escapedRunnerWorkflow)]),
    ],
    ["escaped-workflow-utf16le.bin", Buffer.from(`# synthetic fixture\n${escapedRunnerWorkflow}`, "utf16le")],
    ["escaped-workflow-utf16be.bin", Buffer.from(escapedRunnerWorkflow, "utf16le").swap16()],
    ["escaped-workflow-nul.bin", Buffer.concat([Buffer.from(escapedRunnerWorkflow), Buffer.from([0])])],
  ];
  for (const [name, content] of hostileCases) {
    const root = mkdtempSync(join(tmpdir(), "llmstatus-release-semantic-hostile-"));
    try {
      writeFileSync(join(root, name), content);
      assert.throws(() => scanExport(root), /forbidden content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const safeCases = [
    ["one.yaml", "one: true\n"],
    ["only.yaml", "only: true\n"],
    ["onboarding.yaml", "onboarding: true\n"],
    ["runs-one.yaml", "runs-one: true\n"],
    ["dispatcher.yaml", "workflow_dispatcher: true\n"],
    ["push-value.yaml", "label: push\n"],
    ["pull-value.yaml", "label: pull_request\n"],
    ["schedule-value.yaml", "label: schedule\n"],
    ["workflow-value.json", '{"label":"workflow_dispatch"}\n'],
    ["repository-value.yaml", "label: repository_dispatch\n"],
  ];
  assert.equal(safeCases.length, 10);
  for (const [name, content] of safeCases) {
    const root = mkdtempSync(join(tmpdir(), "llmstatus-release-semantic-safe-"));
    try {
      writeFileSync(join(root, name), content);
      assert.doesNotThrow(() => scanExport(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const codePointRoot = mkdtempSync(join(tmpdir(), "llmstatus-release-code-point-"));
  try {
    writeFileSync(join(codePointRoot, "valid.yaml"), `"${scalarEscape("U", "0001F600")}": value\n`);
    writeFileSync(join(codePointRoot, "invalid.yaml"), `"${scalarEscape("U", "FFFFFFFF")}": value\n`);
    assert.doesNotThrow(() => scanExport(codePointRoot));
  } finally {
    rmSync(codePointRoot, { recursive: true, force: true });
  }
});

test("scanner checks shell, PowerShell, Python, command, extensionless, binary, and NUL bytes", () => {
  const token = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  const cases = [
    ["release.sh", Buffer.from(token)],
    ["release.ps1", Buffer.from(token)],
    ["release.py", Buffer.from(token)],
    ["release.cmd", Buffer.from(token)],
    ["release", Buffer.from(token)],
    ["image.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(token)])],
    ["payload.bin", Buffer.from(token, "utf16le")],
    ["payload-be.bin", Buffer.from(token, "utf16le").swap16()],
    ["nul-containing.dat", Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from(token), Buffer.from([0])])],
  ];
  for (const [name, bytes] of cases) {
    const root = mkdtempSync(join(tmpdir(), "llmstatus-release-bytes-"));
    try {
      writeFileSync(join(root, name), bytes);
      assert.throws(() => scanExport(root), /forbidden content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("scanner rejects internal, personal, and development fixtures", () => {
  const cases = [
    ["internal.txt", ["TASK", "-99"].join("")],
    ["personal.txt", ["/Users/", "sample", "/Documents/", "Dev", "/project"].join("")],
    ["development.txt", ["LLMStatus", "-dev"].join("")],
  ];
  for (const [name, content] of cases) {
    const root = mkdtempSync(join(tmpdir(), "llmstatus-release-content-"));
    try {
      writeFileSync(join(root, name), content);
      assert.throws(() => scanExport(root), /forbidden|private development|internal delivery/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("independent secret scan distinguishes no match from scanner errors", () => {
  const root = mkdtempSync(join(tmpdir(), "llmstatus-secret-scan-"));
  try {
    writeFileSync(join(root, "safe.bin"), Buffer.from([0, 1, 2, 3]));
    assert.equal(scanTrackedSecrets(root, ["safe.bin"]), 1);
    assert.throws(() => scanTrackedSecrets(root, ["missing.bin"]), /ENOENT/);
    assert.equal(assertNoWorkflowPaths([]), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned disposable parent is removed when its operation fails", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "llmstatus-cleanup-parent-"));
  let ownedPath;
  try {
    assert.throws(
      () =>
        withDisposableDirectory(
          "failure-regression",
          (path) => {
            ownedPath = path;
            writeFileSync(join(path, "rejected.bin"), Buffer.from("rejected"));
            throw new Error("synthetic scan failure");
          },
          temporaryRoot,
        ),
      /synthetic scan failure/,
    );
    assert.equal(existsSync(ownedPath), false);
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
