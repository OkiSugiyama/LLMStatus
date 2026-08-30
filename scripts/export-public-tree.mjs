// Materialize the public source tree for the clean public repository.
//
// The public/excluded classification in docs/release/public-tree.json is the
// only authority on what ships. This reuses the same exportPublicTree and
// scanExport that `release-tree.mjs validate` runs, so a file that the
// validator would reject can never reach the public repository through here.
//
// usage: node scripts/export-public-tree.mjs <destination-outside-this-repo>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { exportPublicTree, scanExport } from "./release-tree.mjs";

const destination = process.argv[2];
if (!destination) {
  throw new Error("usage: node scripts/export-public-tree.mjs <destination-outside-this-repo>");
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

execFileSync("git", ["diff", "--quiet"], { cwd: root, stdio: "ignore" });
execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root, stdio: "ignore" });

const paths = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();

const classification = JSON.parse(
  readFileSync(join(root, "docs/release/public-tree.json"), "utf8"),
);

const classified = exportPublicTree({
  sourceRoot: root,
  destinationRoot: resolve(destination),
  paths,
  classification,
});
scanExport(resolve(destination));

process.stdout.write(
  `${JSON.stringify({
    action: "export",
    destination: resolve(destination),
    publicFiles: classified.public.length,
    excludedFiles: classified.excluded.length,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  })}\n`,
);
