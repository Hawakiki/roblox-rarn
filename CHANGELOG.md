# Changelog

Notable changes per release. Dates are release dates.

Rarn follows semver, with one clarification that matters before 1.0: **the manifest and
lockfile formats are not stable yet.** `lockfileVersion` exists so a change can be detected
rather than silently misread, and a `0.x` release may bump it.

## Unreleased

### Fixed

- **Resolution could install a version that does not satisfy a requirement, and
  report success** (RN-5). When greedy grouping produced two versions sharing a
  major, they were merged and the higher one kept — which is semver's contract for a
  *caret* requirement and for nothing else. `~1.2.0` and `^1.5.0` share a major and
  have an empty intersection, so the merge installed `1.9.0`, recorded `~1.2.0`
  beside it in the lockfile as satisfied, and printed `installed`. The surviving
  version is now re-checked against every constraint it absorbs — including the ones
  the group already held, since raising the survivor can break those too — and
  anything it cannot satisfy is reported as a conflict (`RN0200`) naming the
  requesters and their ranges. Compatible ranges that genuinely do intersect, such as
  `^1.2.0` and `^1.5.0`, still collapse to one version.

- **`rarn install` could delete a directory it did not create** (RN-1). Installing
  replaces the realm directories wholesale, and the only thing separating that from a
  user's source tree was the directory *name* — which on Windows and macOS does not
  even distinguish `Packages` from `packages`. Since `rarn import` writes
  `packageDir: "Packages"`, a monorepo with a `packages/` source directory lost it to
  `rarn import && rarn install`, with no warning and a success line. Installing now
  refuses (`RN0421`) unless the directory holds `_Index/` or nothing but Rarn's own
  generated shims, and says so before any download rather than at swap time. An
  existing Wally install still passes, because replacing one is what migrating means.
  `rarn import` warns about the same collision at the moment it picks the name.

- **The require harness could not check a cross-realm shim, and reported the correct
  form as broken** (RN-2). A shim crossing realms names an absolute DataModel path,
  and the harness's `game` stub returned a bare table, so the path resolved to nil.
  `verify.luau` now takes `--mount=<DataModelPath>=<dir>` and the runtime builds
  `game` from those mounts, wrapping them through the same proxy table as the primary
  realm — so a package reached across a realm boundary still compares equal to itself.
  Without a mount the check is reported as *not verified* rather than failed, and the
  harness test now exercises both paths, which CI never did.

## 0.1.0 — 2026-08-21

First release. The install path is complete and verified; publishing works but has never been
run against the live registry.

### Install

```toml
# rokit.toml
[tools]
rarn = "Hawakiki/roblox-rarn@0.1.0"
```

```bash
rokit trust Hawakiki/roblox-rarn
rokit install
```

### Commands

`init` `import` `add` `install` `remove` `up` `list` `why` `dedupe` `search` `info`
`outdated` `cache` `doctor` `login` `logout` `whoami` `pack` `publish`

### What it does that Wally does not

- **Order-independent resolution.** Every constraint is collected before any version is
  chosen, so `^1.2.0` and `^1.5.0` both get `1.9.0` instead of failing on a graph that has an
  obvious solution.
- **Integrity digests that are actually written.** Wally's lockfile has a `checksum` field it
  never fills in; Rarn records a `sha256` per archive and checks it on every install.
- **Archives are pruned at install time.** `evaera/promise@4.0.0` ships 340 files and installs
  as 2, and the result needs no Rojo to be correct.
- **Offline is a guarantee.** `--offline` refuses the network rather than happening not to need
  it. With a fresh lockfile and a warm cache an install is 45ms and makes no requests.
- **`rarn import`** turns an existing `wally.toml` into a `rarn.json`, including the Cargo
  bare-version rule that reads `1.0.0` as `^1.0.0`.
- **`rarn why` / `dedupe` / `doctor`** — duplicate versions, who asked for them, and requires in
  the installed source that no dependency declares.

### Known gaps

- `rarn publish` has only been exercised with `--dry-run`. Registry versions are permanent, so
  the live path stays unverified until there is something worth publishing.
- No workspaces. Whether they mean anything on a platform where each member syncs into a
  different DataModel is an open design question.
- Windows binaries are built on Windows: cross-compiling one with `--bytecode` produces a
  binary that segfaults at startup on Bun 1.3.14.
