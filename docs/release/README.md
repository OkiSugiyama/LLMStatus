# Local release preparation

LLMStatus release evidence is produced on owner-controlled physical machines. This directory defines the public source-tree classification and the deterministic local checks; it does not create a repository, commit, remote, or release.

## Public source tree

`public-tree.json` classifies every tracked path exactly once as public or excluded. Run from a clean checkout:

```text
node scripts/release-tree.mjs validate
node scripts/release-tree.mjs verify-determinism
```

Both commands export only to unique disposable system temporary directories and remove their own output on success and failure. `validate` scans every exported regular file as ASCII and both UTF-16 byte orders, including binary and NUL-containing files. `verify-determinism` compares two independent sorted path/size/SHA-256 manifests. Built-in assertions pin the required public and excluded dispositions and reject any tracked hosted-workflow path. Neither command writes to a future publication path or includes Git administration data.

The fixed independent repository checks are:

```text
node scripts/release-tree.mjs assert-no-workflows
node scripts/release-tree.mjs scan-repository-secrets
```

An empty result is success. A Git, filesystem, or scanner error is a failure, not an empty result.

## Dependency notices

After `npm ci --offline`, run:

```text
node scripts/dependency-notices.mjs verify
```

The verifier covers all npm lock packages and the union of locked Cargo packages selected for `aarch64-apple-darwin` and `x86_64-pc-windows-msvc`. It reads the cache directory selected by effective npm configuration and the Cargo archives selected by effective `CARGO_HOME`; this includes npm's Windows default and configured cache locations. It verifies every npm tarball against `package-lock.json` integrity and every selected `.crate` against its `Cargo.lock` SHA-256 before reading material. Every package has exact package/version/file/SHA-256 associations. Own archive license, copyright, and notice material is retained; byte-identical material is deduplicated only after all source and package associations are recorded.

The immutable files under `license-materials/` cover only documented fail-closed exceptions: same-release npm families proven by exact lock edges, Cargo workspaces proven by exact repository and `.cargo_vcs_info` SHA, and official SPDX text for exact authenticated material-less archives or release trees. `provenance.json` records every input URL and SHA-256, while a separate hard-coded approval oracle pins the complete logical/stored file records and every exact VCS/repository/package/license/material association. Coordinated changes to material bytes, manifest hashes, source URLs, encodings, or association groups therefore fail before document generation. The locked material-less `@napi-rs/lzma-linux-x64-gnu@1.5.1` archive associates directly with official SPDX MIT text and requires no non-lock root archive. The MPL-2.0 input is stored as canonical base64 solely to retain its exact upstream whitespace while keeping `git diff --check` enforceable; verification pins both the encoded file and decoded source bytes. Missing, changed, newly unreviewed, or unrelated material fails verification. `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` are public inputs and are configured as future Tauri bundle resources. A no-bundle build does not prove installer or archive contents; every eventual unsigned and signed bundle still requires direct inspection.

## Full local source check

```text
npm run check:release:local
```

This command requires a clean tracked checkout and executes the fixed offline source checks in order. Before the first child, it resolves effective npm cache configuration and effective `CARGO_HOME`, then gives those exact locations and `CARGO_NET_OFFLINE=true` to every child, including npm, Cargo, Tauri, and the dependency verifier. A missing entry in the selected cache fails instead of silently using another home or reaching a registry. It provides preparation evidence only. It does not establish Windows runtime behavior, physical tray or sleep behavior, final binary manifests, installer contents, or publication readiness.

## Unresolved release decisions

- Distributed CPU architectures have not been selected.
- A private vulnerability-reporting channel and security contact have not been selected.
- A current Rust advisory result is unavailable without a deliberately approved advisory database update; absence of such a result is not a zero-vulnerability claim.
- Physical macOS and normal-user Windows verification remains incomplete.
- Public releases are unsigned source releases; users may see normal first-run platform warnings.
