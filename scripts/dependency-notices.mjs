import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const TARGETS = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
const MATERIAL_DIRECTORY = "docs/release/license-materials";

const APPROVED_EXTERNAL_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  spdxLicenseList: {
    repository: "https://github.com/spdx/license-list-data",
    commit: "a3cbf2e897d54bccec0c35469c691521d089ef53",
  },
  files: {
    "cargo-defmt-4a8cdb44-LICENSE-APACHE": {
      sha256: "8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90",
      source: "https://github.com/knurling-rs/defmt/blob/4a8cdb44891ed57b8ff5a023b6bec7137c48708f/LICENSE-APACHE",
    },
    "cargo-defmt-4a8cdb44-LICENSE-MIT": {
      sha256: "2710a622a896bba67356913d4d0492cab5465f61b2ecce6d880aeb483834fb50",
      source: "https://github.com/knurling-rs/defmt/blob/4a8cdb44891ed57b8ff5a023b6bec7137c48708f/LICENSE-MIT",
    },
    "cargo-objc2-7b1abfd7-LICENSE.md": {
      sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      source: "https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md",
    },
    "cargo-objc2-8852b424-LICENSE.md": {
      sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      source: "https://github.com/madsmtm/objc2/blob/8852b424193ca41602281b3d7540d7c8ed51e49a/LICENSE.md",
    },
    "cargo-objc2-8d214f54-LICENSE.md": {
      sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      source: "https://github.com/madsmtm/objc2/blob/8d214f5477365ffcbcbb7de058c86ed9a518efb7/LICENSE.md",
    },
    "cargo-objc2-b4167b58-LICENSE.md": {
      sha256: "7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54",
      source: "https://github.com/madsmtm/objc2/blob/b4167b582b2f75f9a1be75495c41b765344fd03c/LICENSE.md",
    },
    "cargo-rust-alloc-no-stdlib-ae42d220-LICENSE": {
      sha256: "c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae",
      source: "https://github.com/dropbox/rust-alloc-no-stdlib/blob/ae42d22078b98549e987d2f03d12df7b984fde47/LICENSE",
    },
    "cargo-rust-unic-58786053-LICENSE-APACHE": {
      sha256: "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
      source: "https://github.com/open-i18n/rust-unic/blob/5878605364af97a3358368a6eaef02104af2e016/LICENSE-APACHE",
    },
    "cargo-rust-unic-58786053-LICENSE-MIT": {
      sha256: "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
      source: "https://github.com/open-i18n/rust-unic/blob/5878605364af97a3358368a6eaef02104af2e016/LICENSE-MIT",
    },
    "cargo-rust-unic-8a6ce830-LICENSE-APACHE": {
      sha256: "a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2",
      source: "https://github.com/open-i18n/rust-unic/blob/8a6ce83063d90b91ae2ce59eddb803edd393fca9/LICENSE-APACHE",
    },
    "cargo-rust-unic-8a6ce830-LICENSE-MIT": {
      sha256: "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
      source: "https://github.com/open-i18n/rust-unic/blob/8a6ce83063d90b91ae2ce59eddb803edd393fca9/LICENSE-MIT",
    },
    "cargo-webview2-b74dc5e2-LICENSE": {
      sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
      source: "https://github.com/wravery/webview2-rs/blob/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE",
    },
    "cargo-webview2-dffa41a8-LICENSE": {
      sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
      source: "https://github.com/wravery/webview2-rs/blob/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE",
    },
    "spdx-a3cbf2e8-MIT.txt": {
      sha256: "b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5",
      source: "https://github.com/spdx/license-list-data/blob/a3cbf2e897d54bccec0c35469c691521d089ef53/text/MIT.txt",
    },
    "spdx-a3cbf2e8-MPL-2.0.txt": {
      sha256: "66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172",
      source: "https://github.com/spdx/license-list-data/blob/a3cbf2e897d54bccec0c35469c691521d089ef53/text/MPL-2.0.txt",
      storedAs: "spdx-a3cbf2e8-MPL-2.0.txt.base64",
      encoding: "base64",
      encodedSha256: "46e8a53b62ef22605c7b988b43a5c3d61b42de4658b48a049ec7d30b46759459",
    },
  },
});

const LICENSE_SELECTIONS = new Map([
  ["(MIT OR Apache-2.0) AND Unicode-3.0", ["MIT", "Unicode-3.0"]],
  ["0BSD OR MIT OR Apache-2.0", ["0BSD"]],
  ["Apache-2.0", ["Apache-2.0"]],
  ["Apache-2.0 / MIT", ["MIT"]],
  ["Apache-2.0 AND MIT", ["Apache-2.0", "MIT"]],
  ["Apache-2.0 OR MIT", ["MIT"]],
  ["BSD-3-Clause", ["BSD-3-Clause"]],
  ["BSD-3-Clause AND MIT", ["BSD-3-Clause", "MIT"]],
  ["BSD-3-Clause/MIT", ["MIT"]],
  ["CC-BY-4.0", ["CC-BY-4.0"]],
  ["CC0-1.0 OR MIT-0 OR Apache-2.0", ["CC0-1.0"]],
  ["ISC", ["ISC"]],
  ["MIT", ["MIT"]],
  ["MIT OR Apache-2.0", ["MIT"]],
  ["MIT OR Apache-2.0 OR Zlib", ["MIT"]],
  ["MIT OR Zlib OR Apache-2.0", ["MIT"]],
  ["MIT/Apache-2.0", ["MIT"]],
  ["MPL-2.0", ["MPL-2.0"]],
  ["Unicode-3.0", ["Unicode-3.0"]],
  ["Unlicense OR MIT", ["Unlicense", "MIT"]],
  ["Unlicense/MIT", ["Unlicense", "MIT"]],
  ["Zlib", ["Zlib"]],
  ["Zlib OR Apache-2.0 OR MIT", ["Zlib"]],
]);

const EXTERNAL_CARGO_GROUPS = new Map([
  [
    "ae42d22078b98549e987d2f03d12df7b984fde47",
    {
      repository: "https://github.com/dropbox/rust-alloc-no-stdlib",
      packages: ["alloc-stdlib@0.2.4"],
      licenses: { "alloc-stdlib@0.2.4": "BSD-3-Clause" },
      files: ["cargo-rust-alloc-no-stdlib-ae42d220-LICENSE"],
    },
  ],
  [
    "b4167b582b2f75f9a1be75495c41b765344fd03c",
    {
      repository: "https://github.com/madsmtm/objc2",
      packages: ["block2@0.6.2"],
      licenses: { "block2@0.6.2": "MIT" },
      files: ["cargo-objc2-b4167b58-LICENSE.md"],
    },
  ],
  [
    "4a8cdb44891ed57b8ff5a023b6bec7137c48708f",
    {
      repository: "https://github.com/knurling-rs/defmt",
      packages: ["defmt-parser@1.0.0"],
      licenses: { "defmt-parser@1.0.0": "MIT OR Apache-2.0" },
      files: ["cargo-defmt-4a8cdb44-LICENSE-APACHE", "cargo-defmt-4a8cdb44-LICENSE-MIT"],
    },
  ],
  [
    "8852b424193ca41602281b3d7540d7c8ed51e49a",
    {
      repository: "https://github.com/madsmtm/objc2",
      packages: ["dispatch2@0.3.1", "objc2@0.6.4"],
      licenses: { "dispatch2@0.3.1": "Zlib OR Apache-2.0 OR MIT", "objc2@0.6.4": "MIT" },
      files: ["cargo-objc2-8852b424-LICENSE.md"],
    },
  ],
  [
    "7b1abfd750a2cacaea71d6a56ecfb83cb7de560b",
    {
      repository: "https://github.com/madsmtm/objc2",
      packages: [
        "objc2-app-kit@0.3.2",
        "objc2-core-foundation@0.3.2",
        "objc2-core-graphics@0.3.2",
        "objc2-foundation@0.3.2",
        "objc2-io-surface@0.3.2",
        "objc2-web-kit@0.3.2",
      ],
      licenses: {
        "objc2-app-kit@0.3.2": "Zlib OR Apache-2.0 OR MIT",
        "objc2-core-foundation@0.3.2": "Zlib OR Apache-2.0 OR MIT",
        "objc2-core-graphics@0.3.2": "Zlib OR Apache-2.0 OR MIT",
        "objc2-foundation@0.3.2": "MIT",
        "objc2-io-surface@0.3.2": "Zlib OR Apache-2.0 OR MIT",
        "objc2-web-kit@0.3.2": "Zlib OR Apache-2.0 OR MIT",
      },
      files: ["cargo-objc2-7b1abfd7-LICENSE.md"],
    },
  ],
  [
    "8d214f5477365ffcbcbb7de058c86ed9a518efb7",
    {
      repository: "https://github.com/madsmtm/objc2",
      packages: ["objc2-encode@4.1.0", "objc2-exception-helper@0.1.1"],
      licenses: {
        "objc2-encode@4.1.0": "MIT",
        "objc2-exception-helper@0.1.1": "Zlib OR Apache-2.0 OR MIT",
      },
      files: ["cargo-objc2-8d214f54-LICENSE.md"],
    },
  ],
  [
    "635e1a19d02960588a00e189bd4bd5bdb150ec3d",
    {
      repository: "https://github.com/servo/stylo",
      packages: ["selectors@0.36.1"],
      licenses: { "selectors@0.36.1": "MPL-2.0" },
      files: ["spdx-a3cbf2e8-MPL-2.0.txt"],
      upstreamMaterialAbsent: true,
      spdxId: "MPL-2.0",
    },
  ],
  [
    "5878605364af97a3358368a6eaef02104af2e016",
    {
      repository: "https://github.com/open-i18n/rust-unic",
      packages: [
        "unic-char-property@0.9.0",
        "unic-char-range@0.9.0",
        "unic-common@0.9.0",
        "unic-ucd-version@0.9.0",
      ],
      licenses: {
        "unic-char-property@0.9.0": "MIT/Apache-2.0",
        "unic-char-range@0.9.0": "MIT/Apache-2.0",
        "unic-common@0.9.0": "MIT/Apache-2.0",
        "unic-ucd-version@0.9.0": "MIT/Apache-2.0",
      },
      files: ["cargo-rust-unic-58786053-LICENSE-APACHE", "cargo-rust-unic-58786053-LICENSE-MIT"],
    },
  ],
  [
    "8a6ce83063d90b91ae2ce59eddb803edd393fca9",
    {
      repository: "https://github.com/open-i18n/rust-unic",
      packages: ["unic-ucd-ident@0.9.0"],
      licenses: { "unic-ucd-ident@0.9.0": "MIT/Apache-2.0" },
      files: ["cargo-rust-unic-8a6ce830-LICENSE-APACHE", "cargo-rust-unic-8a6ce830-LICENSE-MIT"],
    },
  ],
  [
    "b74dc5e2b394044bea5191052868ce7a106c202c",
    {
      repository: "https://github.com/wravery/webview2-rs",
      packages: ["webview2-com@0.38.2", "webview2-com-sys@0.38.2"],
      licenses: { "webview2-com@0.38.2": "MIT", "webview2-com-sys@0.38.2": "MIT" },
      files: ["cargo-webview2-b74dc5e2-LICENSE"],
    },
  ],
  [
    "dffa41a8a46d3f5565eefbff2de57d38d399f158",
    {
      repository: "https://github.com/wravery/webview2-rs",
      packages: ["webview2-com-macros@0.8.1"],
      licenses: { "webview2-com-macros@0.8.1": "MIT" },
      files: ["cargo-webview2-dffa41a8-LICENSE"],
    },
  ],
]);

const NAPI_PLATFORM_RELEASE = Object.freeze({
  name: "@napi-rs/lzma-linux-x64-gnu",
  version: "1.5.1",
  license: "MIT",
  repository: "https://github.com/Brooooooklyn/lzma",
  resolved: "https://registry.npmjs.org/@napi-rs/lzma-linux-x64-gnu/-/lzma-linux-x64-gnu-1.5.1.tgz",
  integrity: "sha512-oTXEIha4SsuXdTA4Iyskj0kpdx2yVXdhd75c2v3xGrHFfVMsbhTPZU/nMPL4sWKo4pBHm3aucLaqGlF696dTyQ==",
  material: "spdx-a3cbf2e8-MIT.txt",
});

const STACKBACK_RELEASE = Object.freeze({
  name: "stackback",
  version: "0.0.2",
  license: "MIT",
  repository: "https://github.com/shtylman/node-stackback",
  resolved: "https://registry.npmjs.org/stackback/-/stackback-0.0.2.tgz",
  integrity: "sha512-1XMJE5fQo1jGH6Y/7ebnwPOBEkIEnT4QF32d5R1+VXdXveM0IBMJt8zfaxX1P3QhVwrYe+576+jkANtSS2mBbw==",
  material: "spdx-a3cbf2e8-MIT.txt",
  tagObject: "a3ebcabaf09f9df7d7cfa913cb18fa869bd2a58d",
  commit: "2963095372abf7b75ba55f01cef08ab1e62c2ff4",
});

const APPROVED_NPM_EXCEPTION_HASHES = Object.freeze({
  "@napi-rs/lzma-linux-x64-gnu@1.5.1": "9d458ceddacbe7e7d2a375186ce357db284a1daaaa2bc86aa5eebdc54fe64350",
  "stackback@0.0.2": "e7b60e3dc631f05a705a75401dc33816f198c4c36518ecbabe9d25c4aa7987da",
});

const APPROVED_CARGO_ASSOCIATION_HASHES = Object.freeze({
  "ae42d22078b98549e987d2f03d12df7b984fde47": "783436537f712894b38979caaa21498438878d4c0b26d52cc5206793039f9388",
  "b4167b582b2f75f9a1be75495c41b765344fd03c": "400494d1dfecd1d8709e98f8efd20fd0b3b8b9dd2babaf0ff1a35b326434a6f6",
  "4a8cdb44891ed57b8ff5a023b6bec7137c48708f": "2ff11bcc036827ea938f4e433c9712fe2d277516c10ac4f5326da974c13ef471",
  "8852b424193ca41602281b3d7540d7c8ed51e49a": "66fd0d019f37c3a1c7ed28e3d96ad63e0ce595ec78995e7afdff37de92b5ae03",
  "7b1abfd750a2cacaea71d6a56ecfb83cb7de560b": "5054097d2e0650b5881bb372c62c343cc60a9f564c058a1f5648d20c914321a7",
  "8d214f5477365ffcbcbb7de058c86ed9a518efb7": "9bf2353bb1581aa3f60e00bff096759b73d67703401a91446405846c30c10ed5",
  "635e1a19d02960588a00e189bd4bd5bdb150ec3d": "89185c0a44fb00299f5ba8e9e5fef1ec3632c26721889e04ad27de2c40c3090b",
  "5878605364af97a3358368a6eaef02104af2e016": "30b508fd66c300bd9127985ab64d9b1c6df2200ce3de6f1e0cf74629732685b0",
  "8a6ce83063d90b91ae2ce59eddb803edd393fca9": "228723c48a1737110da72d306e45e5b3f72526a14cd774a104a0b174248b1e7d",
  "b74dc5e2b394044bea5191052868ce7a106c202c": "b65d75d94449109e1c8a991057112731d80d7ad5edea9dea4beb16226a1e7558",
  "dffa41a8a46d3f5565eefbff2de57d38d399f158": "7aa96ded5bdbf62093f9058f0e092e7346609c106814a44341691efeae7b8cd4",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cargoAssociationFingerprint(group) {
  return sha256(Buffer.from(canonicalJson(group), "utf8"));
}

export function npmExceptionFingerprint(exception) {
  return sha256(Buffer.from(canonicalJson(exception), "utf8"));
}

export function assertApprovedNpmException(key, exception) {
  if (npmExceptionFingerprint(exception) !== APPROVED_NPM_EXCEPTION_HASHES[key]) {
    throw new Error(`approved npm material exception changed for ${key}`);
  }
}

export function assertApprovedCargoAssociation(vcsSha, group) {
  const expected = APPROVED_CARGO_ASSOCIATION_HASHES[vcsSha];
  if (!expected || cargoAssociationFingerprint(group) !== expected) {
    throw new Error(`approved Cargo exact-VCS association changed for ${vcsSha}`);
  }
}

export function assertApprovedCargoAssociations(groups = EXTERNAL_CARGO_GROUPS) {
  const actualShas = [...groups.keys()].sort();
  const expectedShas = Object.keys(APPROVED_CARGO_ASSOCIATION_HASHES).sort();
  if (canonicalJson(actualShas) !== canonicalJson(expectedShas)) {
    throw new Error("approved Cargo exact-VCS association set changed");
  }
  for (const sha of expectedShas) {
    assertApprovedCargoAssociation(sha, groups.get(sha));
  }
}

export function assertApprovedExternalProvenance(provenance) {
  if (canonicalJson(provenance) !== canonicalJson(APPROVED_EXTERNAL_PROVENANCE)) {
    throw new Error("approved external license provenance changed");
  }
}

function normalizedRepository(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function selectedLicenseIds(expression) {
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("dependency has no license expression");
  }
  const selected = LICENSE_SELECTIONS.get(expression);
  if (!selected) throw new Error(`unreviewed license expression: ${expression}`);
  return selected;
}

function safeArchivePath(path, label) {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} contains unsafe archive path: ${JSON.stringify(path)}`);
  }
  return path;
}

function tarString(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function tarNumber(header, start, length, label) {
  const field = tarString(header, start, length).trim();
  if (!/^[0-7]*$/.test(field)) throw new Error(`${label} has unsupported tar number`);
  return Number.parseInt(field || "0", 8);
}

function parsePax(bytes, label) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error(`${label} has invalid PAX data`);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[0-9]+$/.test(lengthText)) throw new Error(`${label} has invalid PAX length`);
    const length = Number(lengthText);
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    if (bytes[offset + length - 1] !== 0x0a) throw new Error(`${label} has invalid PAX record`);
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

export function parseTarGzip(archiveBytes, label = "archive") {
  let tar;
  try {
    tar = gunzipSync(archiveBytes);
  } catch (error) {
    throw new Error(`${label} is not a valid gzip archive: ${error instanceof Error ? error.message : error}`);
  }
  const entries = new Map();
  let offset = 0;
  let longPath = null;
  let pax = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12, label);
    const storedChecksum = tarNumber(header, 148, 8, label);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const calculatedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== calculatedChecksum) throw new Error(`${label} has an invalid tar checksum`);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 0x30);
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error(`${label} has a truncated tar entry`);
    const data = tar.subarray(start, end);
    if (type === "x" || type === "g") {
      const parsed = parsePax(data, label);
      if (type === "x") pax = parsed;
    } else if (type === "L") {
      longPath = data.toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "0" || type === "\0") {
      const path = safeArchivePath(pax?.path ?? longPath ?? headerPath, label);
      if (entries.has(path)) throw new Error(`${label} has duplicate archive path: ${path}`);
      entries.set(path, Buffer.from(data));
      longPath = null;
      pax = null;
    } else {
      longPath = null;
      pax = null;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (entries.size === 0) throw new Error(`${label} has no regular files`);
  return entries;
}

export function verifyIntegrity(bytes, integrity, label = "archive") {
  const match = /^(sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) throw new Error(`${label} has unsupported or missing integrity`);
  const actual = createHash(match[1]).update(bytes).digest("base64");
  if (actual !== match[2]) throw new Error(`${label} integrity does not match package-lock.json`);
  return { algorithm: match[1], digest: Buffer.from(match[2], "base64") };
}

function npmCachePath(cacheRoot, integrity, label) {
  const match = /^(sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) throw new Error(`${label} has unsupported or missing integrity`);
  const hex = Buffer.from(match[2], "base64").toString("hex");
  return join(cacheRoot, match[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveNpmContentCacheRoot(cacheDirectory, platform = process.platform) {
  if (typeof cacheDirectory !== "string" || cacheDirectory.trim().length === 0) {
    throw new Error("npm effective cache directory is unavailable");
  }
  const paths = pathApi(platform);
  return paths.join(paths.resolve(cacheDirectory.trim()), "_cacache", "content-v2");
}

export function resolveEffectiveCargoHome({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  cargoHome,
} = {}) {
  const selected = cargoHome ?? environment.CARGO_HOME ?? pathApi(platform).join(homeDirectory, ".cargo");
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new Error("Cargo effective CARGO_HOME is unavailable");
  }
  return pathApi(platform).resolve(selected.trim());
}

export function npmArchiveCachePath(cacheRoot, integrity, label = "npm archive") {
  return npmCachePath(cacheRoot, integrity, label);
}

function readEffectiveNpmCacheDirectory(root, environment) {
  const selected = execFileSync("npm", ["config", "get", "cache"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!selected || selected === "undefined" || selected === "null") {
    throw new Error("npm effective cache directory is unavailable");
  }
  return selected;
}

function materialKind(path) {
  const name = basename(path).toLowerCase();
  const match = /^(license|licence|copying|unlicense|notice|copyright)(.*)$/.exec(name);
  if (!match) return null;
  const suffix = match[2];
  if (suffix) {
    if (!/^[-_.][a-z0-9+.-]+$/.test(suffix)) return null;
    const extension = suffix.split(".").at(-1);
    if (new Set(["c", "cc", "cpp", "h", "hpp", "js", "jsx", "mjs", "rs", "ts", "tsx"]).has(extension)) {
      return null;
    }
  }
  return new Set(["notice", "copyright"]).has(match[1]) ? "supplementary" : "primary";
}

function materialEntries(entries, sourcePrefix, proof) {
  return [...entries.entries()]
    .filter(([path]) => materialKind(path))
    .map(([path, bytes]) => ({
      bytes,
      kind: materialKind(path),
      sha256: sha256(bytes),
      source: `${sourcePrefix}/${path}`,
      proof,
    }))
    .sort((left, right) => left.source.localeCompare(right.source));
}

function parseJsonEntry(entries, path, label) {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`${label} is missing ${path}`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} has invalid ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function readNpmArchive({ name, version, license, integrity, lockPath, resolved }, cacheRoot) {
  const label = `npm ${name}@${version}`;
  const path = npmCachePath(cacheRoot, integrity, label);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label} exact cache archive is unavailable`);
  const archive = readFileSync(path);
  verifyIntegrity(archive, integrity, label);
  const entries = parseTarGzip(archive, label);
  const manifestPaths = [...entries.keys()].filter(
    (entryPath) => entryPath.split("/").length === 2 && basename(entryPath) === "package.json",
  );
  if (manifestPaths.length !== 1) throw new Error(`${label} has no unique root package.json`);
  const manifest = parseJsonEntry(entries, manifestPaths[0], label);
  if (manifest.name !== name || manifest.version !== version || manifest.license !== license) {
    throw new Error(`${label} archive manifest does not match locked name/version/license`);
  }
  const proof = `own npm archive; package-lock integrity ${integrity}`;
  return {
    ecosystem: "npm",
    name,
    version,
    license,
    selectedLicenseIds: selectedLicenseIds(license),
    provenance: `${resolved ?? "PM-authenticated npm registry metadata"}; ${integrity}`,
    resolved: resolved ?? null,
    integrity,
    lockPath,
    targets: ["package-lock.json"],
    manifest,
    materials: materialEntries(entries, `npm:${name}@${version}`, proof),
    associationProof: proof,
  };
}

function npmNameFromLockPath(path) {
  const suffix = path.split("node_modules/").at(-1);
  if (!suffix || suffix.includes("/node_modules/")) throw new Error(`invalid npm lock path: ${path}`);
  return suffix;
}

function loadNpmPackages(root, npmCacheRoot) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3) throw new Error("package-lock.json lockfileVersion must be 3");
  const records = [];
  const lockByName = new Map();
  for (const [lockPath, packageValue] of Object.entries(lock.packages)) {
    if (!lockPath || !packageValue.version) continue;
    const name = npmNameFromLockPath(lockPath);
    if (!packageValue.resolved || !packageValue.integrity) {
      throw new Error(`npm provenance is incomplete for ${name}@${packageValue.version}`);
    }
    records.push(
      readNpmArchive(
        {
          name,
          version: packageValue.version,
          license: packageValue.license,
          integrity: packageValue.integrity,
          lockPath,
          resolved: packageValue.resolved,
        },
        npmCacheRoot,
      ),
    );
    lockByName.set(name, packageValue);
  }
  records.sort(packageSort);
  const keys = new Set();
  for (const record of records) {
    const key = `${record.name}@${record.version}`;
    if (keys.has(key)) throw new Error(`duplicate npm dependency identity: ${key}`);
    keys.add(key);
  }
  return { records, lockByName };
}

function npmFamilySource(name) {
  if (name.startsWith("@esbuild/")) return "esbuild";
  if (name.startsWith("@rollup/rollup-")) return "rollup";
  if (name.startsWith("@tauri-apps/cli-")) return "@tauri-apps/cli";
  return null;
}

export function assertNpmFamilyFallback(dependency, source, lockedSource) {
  const pinned = lockedSource?.optionalDependencies?.[dependency.name];
  if (dependency.version !== source.version || pinned !== dependency.version) {
    throw new Error(`npm family fallback edge/version mismatch for ${dependency.name}@${dependency.version}`);
  }
  const dependencyRepository = normalizedRepository(dependency.manifest.repository);
  const sourceRepository = normalizedRepository(source.manifest.repository);
  if (dependencyRepository && sourceRepository && dependencyRepository !== sourceRepository) {
    throw new Error(`npm family fallback repository mismatch for ${dependency.name}@${dependency.version}`);
  }
  if (!source.materials.some((material) => material.kind === "primary")) {
    throw new Error(`npm family fallback source has no license material: ${source.name}@${source.version}`);
  }
}

function externalMaterial(materials, file, proof) {
  const input = materials.get(file);
  if (!input) throw new Error(`approved external license input is unavailable: ${file}`);
  return { bytes: input.bytes, kind: "primary", sha256: input.sha256, source: input.source, proof };
}

function associateNpmFallbacks(records, lockByName, externalMaterials) {
  assertApprovedNpmException(`${NAPI_PLATFORM_RELEASE.name}@${NAPI_PLATFORM_RELEASE.version}`, NAPI_PLATFORM_RELEASE);
  assertApprovedNpmException(`${STACKBACK_RELEASE.name}@${STACKBACK_RELEASE.version}`, STACKBACK_RELEASE);
  const byName = new Map(records.map((record) => [record.name, record]));
  for (const record of records) {
    if (record.materials.some((material) => material.kind === "primary")) continue;
    const family = npmFamilySource(record.name);
    if (family) {
      const source = byName.get(family);
      if (!source) throw new Error(`npm family fallback source is not locked: ${family}`);
      assertNpmFamilyFallback(record, source, lockByName.get(family));
      const proof = `same-release npm family: package-lock ${family}@${source.version} optionalDependencies pins ${record.name}@${record.version}`;
      record.materials = source.materials.map((material) => ({ ...material, proof }));
      record.associationProof = proof;
      continue;
    }
    if (record.name === NAPI_PLATFORM_RELEASE.name && record.version === NAPI_PLATFORM_RELEASE.version) {
      const locked = lockByName.get(record.name);
      if (
        record.materials.length !== 0 ||
        locked?.version !== NAPI_PLATFORM_RELEASE.version ||
        locked?.resolved !== NAPI_PLATFORM_RELEASE.resolved ||
        locked?.integrity !== NAPI_PLATFORM_RELEASE.integrity ||
        record.resolved !== NAPI_PLATFORM_RELEASE.resolved ||
        record.integrity !== NAPI_PLATFORM_RELEASE.integrity ||
        normalizedRepository(record.manifest.repository) !== normalizedRepository(NAPI_PLATFORM_RELEASE.repository) ||
        record.manifest.license !== NAPI_PLATFORM_RELEASE.license
      ) {
        throw new Error("@napi-rs/lzma exact locked platform release proof changed");
      }
      const proof = `exact locked npm platform archive ${record.name}@${record.version}; package-lock integrity ${record.integrity}; repository ${NAPI_PLATFORM_RELEASE.repository}; exact archive declares MIT and has no material file; official SPDX MIT text; no auxiliary root archive`;
      record.materials = [externalMaterial(externalMaterials, NAPI_PLATFORM_RELEASE.material, proof)];
      record.associationProof = proof;
      continue;
    }
    if (record.name === STACKBACK_RELEASE.name && record.version === STACKBACK_RELEASE.version) {
      const locked = lockByName.get(record.name);
      if (
        record.materials.length !== 0 ||
        locked?.resolved !== STACKBACK_RELEASE.resolved ||
        locked?.integrity !== STACKBACK_RELEASE.integrity ||
        record.resolved !== STACKBACK_RELEASE.resolved ||
        record.integrity !== STACKBACK_RELEASE.integrity ||
        normalizedRepository(record.manifest.repository) !== normalizedRepository(STACKBACK_RELEASE.repository) ||
        record.manifest.author !== "Roman Shtylman <shtylman@gmail.com>" ||
        record.manifest.license !== STACKBACK_RELEASE.license
      ) {
        throw new Error("stackback exact release proof changed");
      }
      const proof = `exact npm archive declares MIT and has no material file; repository ${STACKBACK_RELEASE.repository}; annotated tag ${STACKBACK_RELEASE.tagObject} resolves commit ${STACKBACK_RELEASE.commit}; official SPDX MIT text; no copyright notice invented`;
      record.materials = [externalMaterial(externalMaterials, STACKBACK_RELEASE.material, proof)];
      record.associationProof = proof;
      continue;
    }
    throw new Error(`npm package has no exact corresponding license material: ${record.name}@${record.version}`);
  }
}

function runCargoMetadata(root, target, cargoHome) {
  return JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--offline",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--format-version",
        "1",
        "--filter-platform",
        target,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CARGO_HOME: cargoHome, CARGO_NET_OFFLINE: "true" },
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

function parseCargoLock(root) {
  const text = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const result = new Map();
  for (const block of text.split(/\n\[\[package\]\]\n/).slice(1)) {
    const read = (field) => block.match(new RegExp(`^${field} = "([^"]+)"$`, "m"))?.[1];
    const name = read("name");
    const version = read("version");
    if (!name || !version) throw new Error("Cargo.lock package is missing name or version");
    const source = read("source") ?? null;
    const checksum = read("checksum") ?? null;
    const key = `${name}@${version}|${source ?? "workspace"}`;
    if (result.has(key)) throw new Error(`duplicate Cargo.lock package: ${key}`);
    result.set(key, { source, checksum });
  }
  return result;
}

function parseCargoManifest(bytes, label) {
  const text = bytes.toString("utf8");
  const marker = text.search(/^\[package\]\s*$/m);
  if (marker < 0) throw new Error(`${label} has no Cargo.toml package section`);
  const afterMarker = text.slice(marker).replace(/^\[package\]\s*\n?/, "");
  const nextSection = afterMarker.search(/^\[/m);
  const packageSection = nextSection < 0 ? afterMarker : afterMarker.slice(0, nextSection);
  const read = (field) => packageSection.match(new RegExp(`^${field} = "([^"]+)"$`, "m"))?.[1];
  return { name: read("name"), version: read("version"), license: read("license") };
}

function cargoArchivePath(cargoHome, manifestPath, name, version) {
  const registryId = basename(dirname(dirname(manifestPath)));
  return join(cargoHome, "registry", "cache", registryId, `${name}-${version}.crate`);
}

function cargoRecordFromMetadata(packageValue, target, lock, cargoHome) {
  const key = `${packageValue.name}@${packageValue.version}`;
  if (!packageValue.source?.startsWith("registry+")) throw new Error(`unsupported Cargo provenance for ${key}`);
  const locked = lock.get(`${key}|${packageValue.source}`);
  if (!locked?.checksum || locked.source !== packageValue.source) {
    throw new Error(`Cargo lock provenance is unavailable for ${key}`);
  }
  const archivePath = cargoArchivePath(cargoHome, packageValue.manifest_path, packageValue.name, packageValue.version);
  if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) {
    throw new Error(`Cargo exact crate archive is unavailable for ${key}`);
  }
  const archive = readFileSync(archivePath);
  if (sha256(archive) !== locked.checksum) {
    throw new Error(`Cargo crate archive checksum does not match Cargo.lock for ${key}`);
  }
  const entries = parseTarGzip(archive, `Cargo ${key}`);
  const prefix = `${packageValue.name}-${packageValue.version}`;
  const manifestBytes = entries.get(`${prefix}/Cargo.toml`);
  if (!manifestBytes) throw new Error(`Cargo ${key} archive is missing Cargo.toml`);
  const manifest = parseCargoManifest(manifestBytes, `Cargo ${key}`);
  if (
    manifest.name !== packageValue.name ||
    manifest.version !== packageValue.version ||
    manifest.license !== packageValue.license
  ) {
    throw new Error(`Cargo ${key} archive manifest does not match metadata name/version/license`);
  }
  const proof = `own Cargo .crate; Cargo.lock sha256 ${locked.checksum}`;
  const vcsBytes = entries.get(`${prefix}/.cargo_vcs_info.json`);
  const vcs = vcsBytes ? JSON.parse(vcsBytes.toString("utf8")) : null;
  return {
    ecosystem: "cargo",
    name: packageValue.name,
    version: packageValue.version,
    license: packageValue.license,
    selectedLicenseIds: selectedLicenseIds(packageValue.license),
    provenance: `${packageValue.source}; crate-sha256:${locked.checksum}`,
    targets: [target],
    repository: packageValue.repository,
    authors: packageValue.authors,
    vcsSha: vcs?.git?.sha1 ?? null,
    materials: materialEntries(entries, `cargo:${key}`, proof),
    associationProof: proof,
  };
}

function associateCargoFallback(record, externalMaterials) {
  if (record.materials.some((material) => material.kind === "primary")) return;
  const key = `${record.name}@${record.version}`;
  const group = record.vcsSha ? EXTERNAL_CARGO_GROUPS.get(record.vcsSha) : null;
  if (!group || !group.packages.includes(key)) {
    throw new Error(`Cargo package has no approved exact-VCS material mapping: ${key}`);
  }
  if (group.licenses[key] !== record.license) {
    throw new Error(`Cargo exact-VCS material license association mismatch: ${key}`);
  }
  if (normalizedRepository(record.repository) !== normalizedRepository(group.repository)) {
    throw new Error(`Cargo exact-VCS material repository mismatch: ${key}`);
  }
  if (group.spdxId && !record.selectedLicenseIds.includes(group.spdxId)) {
    throw new Error(`Cargo SPDX fallback license mismatch: ${key}`);
  }
  const absence = group.upstreamMaterialAbsent
    ? `; exact VCS tree has no material file; official SPDX ${group.spdxId} text; authors ${record.authors.join(", ") || "not declared"}; no copyright notice invented`
    : "";
  const proof = `exact Cargo .crate manifest and checksum plus repository ${group.repository} at .cargo_vcs_info git SHA ${record.vcsSha}${absence}`;
  record.materials = group.files.map((file) => externalMaterial(externalMaterials, file, proof));
  record.associationProof = proof;
}

function loadCargoPackages(root, cargoHome, externalMaterials) {
  assertApprovedCargoAssociations();
  const lock = parseCargoLock(root);
  const union = new Map();
  for (const target of TARGETS) {
    const metadata = runCargoMetadata(root, target, cargoHome);
    for (const packageValue of metadata.packages) {
      if (packageValue.name === "llmstatus" && packageValue.source === null) continue;
      const key = `${packageValue.name}@${packageValue.version}`;
      const candidate = cargoRecordFromMetadata(packageValue, target, lock, cargoHome);
      const prior = union.get(key);
      if (prior) {
        for (const field of ["license", "provenance", "repository", "vcsSha"]) {
          if (prior[field] !== candidate[field]) throw new Error(`Cargo target metadata mismatch: ${key}`);
        }
        prior.targets = [...new Set([...prior.targets, target])].sort();
      } else {
        union.set(key, candidate);
      }
    }
  }
  const result = [...union.values()].sort(packageSort);
  for (const record of result) associateCargoFallback(record, externalMaterials);
  for (const [sha, group] of EXTERNAL_CARGO_GROUPS) {
    const found = result.filter((record) => record.vcsSha === sha).map((record) => `${record.name}@${record.version}`).sort();
    if (JSON.stringify(found) !== JSON.stringify([...group.packages].sort())) {
      throw new Error(`Cargo exact-VCS fallback package set changed for ${sha}`);
    }
  }
  return result;
}

export function loadExternalMaterials(materialRoot) {
  const provenance = JSON.parse(readFileSync(join(materialRoot, "provenance.json"), "utf8"));
  assertApprovedExternalProvenance(provenance);
  const expectedFiles = Object.keys(provenance.files).sort();
  const expectedStoredFiles = expectedFiles.map((file) => provenance.files[file].storedAs ?? file).sort();
  if (new Set(expectedStoredFiles).size !== expectedStoredFiles.length) {
    throw new Error("approved external license storage names are not unique");
  }
  const actualFiles = readdirSync(materialRoot).filter((name) => name !== "provenance.json").sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedStoredFiles)) {
    throw new Error("approved external license input file set changed");
  }
  const result = new Map();
  for (const file of expectedFiles) {
    const metadata = provenance.files[file];
    const storedAs = metadata.storedAs ?? file;
    if (
      !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
      !metadata.source ||
      (metadata.encoding !== undefined && metadata.encoding !== "base64") ||
      (metadata.encoding === "base64" && !/^[0-9a-f]{64}$/.test(metadata.encodedSha256 ?? ""))
    ) {
      throw new Error(`approved external license provenance is invalid: ${file}`);
    }
    const path = join(materialRoot, storedAs);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`approved external license input is missing: ${file}`);
    }
    const storedBytes = readFileSync(path);
    if (metadata.encodedSha256 && sha256(storedBytes) !== metadata.encodedSha256) {
      throw new Error(`approved external license encoded input hash mismatch: ${file}`);
    }
    let bytes = storedBytes;
    if (metadata.encoding === "base64") {
      const encoded = storedBytes.toString("ascii");
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
        throw new Error(`approved external license encoding is invalid: ${file}`);
      }
      bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded.replace(/\s/g, "")) {
        throw new Error(`approved external license encoding is non-canonical: ${file}`);
      }
    }
    if (bytes.length === 0 || bytes.includes(0) || sha256(bytes) !== metadata.sha256) {
      throw new Error(`approved external license input hash/content mismatch: ${file}`);
    }
    result.set(file, { bytes, sha256: metadata.sha256, source: metadata.source });
  }
  return result;
}

function packageSort(left, right) {
  return left.ecosystem.localeCompare(right.ecosystem) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function dependencyRows(packages) {
  return packages
    .map((record) => {
      const associations = record.materials.map((material) => `${material.source} (sha256:${material.sha256})`).join("; ");
      return `| ${escapeTable(record.ecosystem)} | ${escapeTable(record.name)} | ${escapeTable(record.version)} | ${escapeTable(record.targets.join(", "))} | ${escapeTable(record.license)} | ${escapeTable(record.selectedLicenseIds.join(", "))} | ${escapeTable(associations)} | ${escapeTable(record.associationProof)} | ${escapeTable(record.provenance)} |`;
    })
    .join("\n");
}

function renderMaterial(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) =>
      line.replace(/[ \t]+$/g, (characters) =>
        [...characters].map((character) => `&#${character.codePointAt(0)};`).join(""),
      ),
    )
    .join("\n")
    .replace(/[^\x00-\x7F]/gu, (character) => `&#${character.codePointAt(0)};`)
    .replace(/\s+$/, "");
}

function dedupeMaterials(packages) {
  const unique = new Map();
  let associationCount = 0;
  for (const record of packages) {
    if (!record.materials.some((material) => material.kind === "primary")) {
      throw new Error(`dependency has no primary license material: ${record.ecosystem}:${record.name}@${record.version}`);
    }
    for (const material of record.materials) {
      associationCount += 1;
      const current = unique.get(material.sha256) ?? {
        bytes: material.bytes,
        sha256: material.sha256,
        sources: new Set(),
        packages: new Set(),
      };
      if (!current.bytes.equals(material.bytes)) throw new Error(`SHA-256 collision for license material ${material.sha256}`);
      current.sources.add(material.source);
      current.packages.add(`${record.ecosystem}:${record.name}@${record.version}`);
      unique.set(material.sha256, current);
    }
  }
  return { associationCount, materials: [...unique.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)) };
}

function generateDocuments(root, cargoPackages, npmPackages) {
  const packages = [...cargoPackages, ...npmPackages].sort(packageSort);
  const { materials, associationCount } = dedupeMaterials(packages);
  const iconVector = readFileSync(join(root, "src-tauri/app-icon.svg"));
  const iconRaster = readFileSync(join(root, "src-tauri/icons/app-icon-source.png"));
  const iconRuntime = readFileSync(join(root, "src-tauri/icons/icon.png"));
  const vectorHash = sha256(iconVector);
  const rasterHash = sha256(iconRaster);
  if (rasterHash !== sha256(iconRuntime)) throw new Error("canonical and runtime application icon rasters differ");

  const notices = `# Third-party notices and asset provenance

This file is generated by \`node scripts/dependency-notices.mjs generate\` from locked, offline npm and Cargo inputs. Verify it offline with \`node scripts/dependency-notices.mjs verify\`.

## Provider identity

LLMStatus does not redistribute ChatGPT, OpenAI, Claude, or Anthropic logo image files. Provider cards use original provider-neutral CSS shapes alongside provider names. LLMStatus is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI or Anthropic.

## LLMStatus application icon

The application icon is an original LLMStatus project asset, copyright 2026 Oki Sugiyama, distributed under the project MIT License. The editable vector is \`src-tauri/app-icon.svg\` (SHA-256 \`${vectorHash}\`). The canonical 512 x 512 RGBA raster is \`src-tauri/icons/app-icon-source.png\` (SHA-256 \`${rasterHash}\`) and is byte-identical to \`src-tauri/icons/icon.png\`. The remaining files under \`src-tauri/icons/\` are generated platform variants.

## Dependency inventory

The Cargo inventory is the union selected by the locked graph for \`${TARGETS[0]}\` and \`${TARGETS[1]}\`. The npm inventory covers every package entry in \`package-lock.json\`. Every row is bound to its exact locked archive before material is read. Own archive material is used whenever present. A same-project fallback is allowed only with an exact lock edge/version/repository or exact Cargo VCS SHA/repository proof. The explicitly documented exact-release trees with no material use official SPDX text at immutable commit \`a3cbf2e897d54bccec0c35469c691521d089ef53\`; no copyright notice is invented. Byte-identical materials are deduplicated in \`THIRD_PARTY_LICENSES.md\` without losing the package/source/hash associations below.

| Ecosystem | Package | Version | Selected by | Declared license | Selected license option | Exact material file and SHA-256 | Association proof | Locked provenance |
|---|---|---|---|---|---|---|---|---|
${dependencyRows(packages)}
`;

  const licenses = `# Third-party license materials

This file is generated by \`node scripts/dependency-notices.mjs generate\`. Each dependency row in \`THIRD_PARTY_NOTICES.md\` records exact ecosystem/name/version/file/SHA-256 associations. Sections below are deduplicated only when the verified source bytes are identical. All source paths remain listed. Non-ASCII code points and trailing horizontal whitespace are represented as decimal character references so the repository remains ASCII-only and whitespace-clean; each SHA-256 covers the unmodified source bytes.

${materials
  .map(
    (material) => `## Material SHA-256 \`${material.sha256}\`

Verified sources:
${[...material.sources].sort().map((source) => `- \`${source}\``).join("\n")}

Associated dependencies:
${[...material.packages].sort().map((dependency) => `- \`${dependency}\``).join("\n")}

\`\`\`text
${renderMaterial(material.bytes)}
\`\`\`
`,
  )
  .join("\n")}`;
  return { notices, licenses, materials, associationCount, packages };
}

export function buildDependencyDocuments(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const environment = options.environment ?? process.env;
  const npmCacheRoot = options.npmCacheRoot
    ? resolve(options.npmCacheRoot)
    : resolveNpmContentCacheRoot(
        options.npmCacheDirectory ?? readEffectiveNpmCacheDirectory(root, environment),
        options.platform ?? process.platform,
      );
  const cargoHome = resolveEffectiveCargoHome({
    environment,
    homeDirectory: options.homeDirectory ?? homedir(),
    platform: options.platform ?? process.platform,
    cargoHome: options.cargoHome,
  });
  const materialRoot = resolve(options.materialRoot ?? join(root, MATERIAL_DIRECTORY));
  const externalMaterials = loadExternalMaterials(materialRoot);
  const { records: npmPackages, lockByName } = loadNpmPackages(root, npmCacheRoot);
  associateNpmFallbacks(npmPackages, lockByName, externalMaterials);
  const cargoPackages = loadCargoPackages(root, cargoHome, externalMaterials);
  const documents = generateDocuments(root, cargoPackages, npmPackages);
  return {
    ...documents,
    cargoCount: cargoPackages.length,
    npmCount: npmPackages.length,
    materialCount: documents.materials.length,
  };
}

function verifyFile(path, expected) {
  if (!existsSync(path)) throw new Error(`generated dependency file is missing: ${path}`);
  if (readFileSync(path, "utf8") !== expected) throw new Error(`generated dependency file is stale: ${path}`);
}

function main() {
  const action = process.argv[2];
  if (!new Set(["generate", "verify"]).has(action)) {
    throw new Error("usage: node scripts/dependency-notices.mjs <generate|verify>");
  }
  const result = buildDependencyDocuments();
  const noticesPath = join(ROOT, "THIRD_PARTY_NOTICES.md");
  const licensesPath = join(ROOT, "THIRD_PARTY_LICENSES.md");
  if (action === "generate") {
    writeFileSync(noticesPath, result.notices);
    writeFileSync(licensesPath, result.licenses);
  } else {
    verifyFile(noticesPath, result.notices);
    verifyFile(licensesPath, result.licenses);
  }
  process.stdout.write(
    `${JSON.stringify({ action, npmPackages: result.npmCount, cargoPackages: result.cargoCount, licenseMaterials: result.materialCount, materialAssociations: result.associationCount })}\n`,
  );
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
