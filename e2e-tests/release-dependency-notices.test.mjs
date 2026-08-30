import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertApprovedCargoAssociation,
  assertApprovedNpmException,
  assertNpmFamilyFallback,
  buildDependencyDocuments,
  loadExternalMaterials,
  npmArchiveCachePath,
  resolveEffectiveCargoHome,
  resolveNpmContentCacheRoot,
  verifyIntegrity,
} from "../scripts/dependency-notices.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATERIALS = join(ROOT, "docs/release/license-materials");

test("all locked npm and dual-target Cargo packages have exact material associations", () => {
  const first = buildDependencyDocuments();
  const second = buildDependencyDocuments();
  assert.equal(first.npmCount, 168);
  assert.equal(first.cargoCount, 280);
  assert.equal(first.materialCount, 223);
  assert.equal(first.associationCount, 681);
  assert.equal(first.packages.length, 448);
  assert.equal(first.notices, second.notices);
  assert.equal(first.licenses, second.licenses);
  for (const packageValue of first.packages) {
    assert.ok(packageValue.materials.some((material) => material.kind === "primary"));
    for (const material of packageValue.materials) {
      assert.match(material.source, /\S/);
      assert.match(material.sha256, /^[0-9a-f]{64}$/);
      assert.equal(createHash("sha256").update(material.bytes).digest("hex"), material.sha256);
    }
  }
});

test("React and both exact jiff packages retain their own archive materials", () => {
  const result = buildDependencyDocuments();
  const react = result.packages.find(
    (packageValue) => packageValue.ecosystem === "npm" && packageValue.name === "react",
  );
  assert.equal(react.version, "19.2.8");
  assert.deepEqual(react.materials.map((material) => material.source), [
    "npm:react@19.2.8/package/LICENSE",
  ]);
  assert.match(result.licenses, /Copyright \(c\) Meta Platforms, Inc\. and affiliates\./);

  for (const [name, version] of [
    ["jiff-tzdb", "0.1.8"],
    ["jiff-tzdb-platform", "0.1.3"],
  ]) {
    const packageValue = result.packages.find(
      (candidate) => candidate.ecosystem === "cargo" && candidate.name === name,
    );
    assert.equal(packageValue.version, version);
    assert.deepEqual(
      packageValue.materials.map((material) => material.source.split("/").at(-1)).sort(),
      ["COPYING", "LICENSE-MIT", "UNLICENSE"],
    );
    assert.match(packageValue.provenance, /crate-sha256:[0-9a-f]{64}$/);
  }
});

test("locked npm archives are sufficient without an auxiliary root archive", () => {
  const npmCacheDirectory = execFileSync("npm", ["config", "get", "cache"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const sourceCache = resolveNpmContentCacheRoot(npmCacheDirectory);
  const lockedOnlyCache = mkdtempSync(join(tmpdir(), "llmstatus-locked-npm-cache-"));
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
    let copied = 0;
    for (const packageValue of Object.values(lock.packages)) {
      if (!packageValue.integrity) continue;
      const source = npmArchiveCachePath(sourceCache, packageValue.integrity);
      const destination = npmArchiveCachePath(lockedOnlyCache, packageValue.integrity);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      copied += 1;
    }
    assert.equal(copied, 168);
    const result = buildDependencyDocuments({ npmCacheRoot: lockedOnlyCache });
    assert.equal(result.npmCount, 168);
    const napi = result.packages.find(
      (packageValue) =>
        packageValue.ecosystem === "npm" && packageValue.name === "@napi-rs/lzma-linux-x64-gnu",
    );
    assert.match(napi.associationProof, /exact locked npm platform archive/);
    assert.doesNotMatch(napi.associationProof, /root\/platform|gitHead/);
  } finally {
    rmSync(lockedOnlyCache, { recursive: true, force: true });
  }
});

test("effective npm and Cargo cache locations are cross-platform and configurable", () => {
  assert.equal(
    resolveNpmContentCacheRoot("C:\\Users\\tester\\AppData\\Local\\npm-cache", "win32"),
    "C:\\Users\\tester\\AppData\\Local\\npm-cache\\_cacache\\content-v2",
  );
  assert.equal(
    resolveNpmContentCacheRoot("/var/tmp/configured-npm-cache", "linux"),
    "/var/tmp/configured-npm-cache/_cacache/content-v2",
  );
  assert.equal(
    resolveEffectiveCargoHome({
      environment: { CARGO_HOME: "C:\\cargo-custom" },
      homeDirectory: "C:\\Users\\tester",
      platform: "win32",
    }),
    "C:\\cargo-custom",
  );
  assert.equal(
    resolveEffectiveCargoHome({
      environment: {},
      homeDirectory: "C:\\Users\\tester",
      platform: "win32",
    }),
    "C:\\Users\\tester\\.cargo",
  );
  assert.equal(
    resolveEffectiveCargoHome({ environment: {}, homeDirectory: "/home/tester", platform: "linux" }),
    "/home/tester/.cargo",
  );

  const emptyNpmCache = mkdtempSync(join(tmpdir(), "llmstatus-configured-npm-cache-"));
  try {
    assert.throws(
      () => buildDependencyDocuments({ npmCacheDirectory: emptyNpmCache }),
      /exact cache archive is unavailable/,
    );
  } finally {
    rmSync(emptyNpmCache, { recursive: true, force: true });
  }

  const emptyCargoHome = mkdtempSync(join(tmpdir(), "llmstatus-configured-cargo-home-"));
  try {
    assert.throws(() => buildDependencyDocuments({ cargoHome: emptyCargoHome }));
  } finally {
    rmSync(emptyCargoHome, { recursive: true, force: true });
  }
});

test("same-release family fallback rejects association mutations", () => {
  const dependency = {
    name: "@example/platform",
    version: "1.2.3",
    manifest: { repository: "https://github.com/example/project" },
  };
  const source = {
    name: "example",
    version: "1.2.3",
    manifest: { repository: "https://github.com/example/project.git" },
    materials: [{ kind: "primary" }],
  };
  const locked = { optionalDependencies: { "@example/platform": "1.2.3" } };
  assert.doesNotThrow(() => assertNpmFamilyFallback(dependency, source, locked));
  assert.throws(
    () => assertNpmFamilyFallback({ ...dependency, version: "1.2.4" }, source, locked),
    /edge\/version mismatch/,
  );
  assert.throws(
    () =>
      assertNpmFamilyFallback(
        { ...dependency, manifest: { repository: "https://github.com/other/project" } },
        source,
        locked,
      ),
    /repository mismatch/,
  );
  assert.throws(
    () => assertNpmFamilyFallback(dependency, { ...source, materials: [] }, locked),
    /no license material/,
  );
});

test("archive integrity and approved external material changes fail closed", () => {
  const bytes = Buffer.from("locked archive bytes");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.doesNotThrow(() => verifyIntegrity(bytes, integrity, "fixture"));
  assert.throws(() => verifyIntegrity(Buffer.from("changed"), integrity, "fixture"), /does not match/);

  const temporary = mkdtempSync(join(tmpdir(), "llmstatus-license-inputs-"));
  try {
    for (const file of readdirSync(MATERIALS)) copyFileSync(join(MATERIALS, file), join(temporary, file));
    assert.equal(loadExternalMaterials(temporary).size, 15);
    rmSync(join(temporary, "cargo-defmt-4a8cdb44-LICENSE-MIT"));
    assert.throws(() => loadExternalMaterials(temporary), /file set changed/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const changed = mkdtempSync(join(tmpdir(), "llmstatus-license-input-change-"));
  try {
    for (const file of readdirSync(MATERIALS)) copyFileSync(join(MATERIALS, file), join(changed, file));
    writeFileSync(join(changed, "spdx-a3cbf2e8-MIT.txt"), "changed\n");
    assert.throws(() => loadExternalMaterials(changed), /hash\/content mismatch/);
  } finally {
    rmSync(changed, { recursive: true, force: true });
  }

  const changedEncoding = mkdtempSync(join(tmpdir(), "llmstatus-license-encoding-change-"));
  try {
    for (const file of readdirSync(MATERIALS)) copyFileSync(join(MATERIALS, file), join(changedEncoding, file));
    writeFileSync(join(changedEncoding, "spdx-a3cbf2e8-MPL-2.0.txt.base64"), "Y2hhbmdlZAo=\n");
    assert.throws(() => loadExternalMaterials(changedEncoding), /encoded input hash mismatch/);
  } finally {
    rmSync(changedEncoding, { recursive: true, force: true });
  }
});

test("independent external provenance and association oracle rejects coordinated changes", () => {
  const changedUrl = mkdtempSync(join(tmpdir(), "llmstatus-license-source-change-"));
  try {
    for (const file of readdirSync(MATERIALS)) copyFileSync(join(MATERIALS, file), join(changedUrl, file));
    const path = join(changedUrl, "provenance.json");
    const provenance = JSON.parse(readFileSync(path, "utf8"));
    provenance.files["cargo-defmt-4a8cdb44-LICENSE-MIT"].source =
      "https://example.invalid/changed-source";
    writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
    assert.throws(() => loadExternalMaterials(changedUrl), /approved external license provenance changed/);
  } finally {
    rmSync(changedUrl, { recursive: true, force: true });
  }

  const changedBytesAndHash = mkdtempSync(join(tmpdir(), "llmstatus-license-coordinated-change-"));
  try {
    for (const file of readdirSync(MATERIALS)) {
      copyFileSync(join(MATERIALS, file), join(changedBytesAndHash, file));
    }
    const material = "cargo-defmt-4a8cdb44-LICENSE-MIT";
    const changed = Buffer.from("coordinated changed material\n");
    writeFileSync(join(changedBytesAndHash, material), changed);
    const path = join(changedBytesAndHash, "provenance.json");
    const provenance = JSON.parse(readFileSync(path, "utf8"));
    provenance.files[material].sha256 = createHash("sha256").update(changed).digest("hex");
    writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
    assert.throws(
      () => loadExternalMaterials(changedBytesAndHash),
      /approved external license provenance changed/,
    );
  } finally {
    rmSync(changedBytesAndHash, { recursive: true, force: true });
  }

  const changedBase64AndHashes = mkdtempSync(join(tmpdir(), "llmstatus-license-base64-coordinated-"));
  try {
    for (const file of readdirSync(MATERIALS)) {
      copyFileSync(join(MATERIALS, file), join(changedBase64AndHashes, file));
    }
    const logical = "spdx-a3cbf2e8-MPL-2.0.txt";
    const stored = "spdx-a3cbf2e8-MPL-2.0.txt.base64";
    const decoded = Buffer.from("coordinated base64 material\n");
    const encoded = Buffer.from(`${decoded.toString("base64")}\n`);
    writeFileSync(join(changedBase64AndHashes, stored), encoded);
    const path = join(changedBase64AndHashes, "provenance.json");
    const provenance = JSON.parse(readFileSync(path, "utf8"));
    provenance.files[logical].sha256 = createHash("sha256").update(decoded).digest("hex");
    provenance.files[logical].encodedSha256 = createHash("sha256").update(encoded).digest("hex");
    writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
    assert.throws(
      () => loadExternalMaterials(changedBase64AndHashes),
      /approved external license provenance changed/,
    );
  } finally {
    rmSync(changedBase64AndHashes, { recursive: true, force: true });
  }

  const defmtSha = "4a8cdb44891ed57b8ff5a023b6bec7137c48708f";
  const remappedDefmt = {
    repository: "https://github.com/knurling-rs/defmt",
    packages: ["defmt-parser@1.0.0"],
    licenses: { "defmt-parser@1.0.0": "MIT OR Apache-2.0" },
    files: ["cargo-objc2-7b1abfd7-LICENSE.md"],
  };
  assert.throws(
    () => assertApprovedCargoAssociation(defmtSha, remappedDefmt),
    /approved Cargo exact-VCS association changed/,
  );
  assert.throws(
    () =>
      assertApprovedNpmException("@napi-rs/lzma-linux-x64-gnu@1.5.1", {
        name: "@napi-rs/lzma-linux-x64-gnu",
        version: "1.5.1",
        license: "Apache-2.0",
        repository: "https://github.com/Brooooooklyn/lzma",
        resolved:
          "https://registry.npmjs.org/@napi-rs/lzma-linux-x64-gnu/-/lzma-linux-x64-gnu-1.5.1.tgz",
        integrity:
          "sha512-oTXEIha4SsuXdTA4Iyskj0kpdx2yVXdhd75c2v3xGrHFfVMsbhTPZU/nMPL4sWKo4pBHm3aucLaqGlF696dTyQ==",
        material: "spdx-a3cbf2e8-MIT.txt",
      }),
    /approved npm material exception changed/,
  );
});
