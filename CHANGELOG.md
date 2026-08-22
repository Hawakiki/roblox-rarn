# Changelog

Notable changes per release. Dates are release dates.

Rarn follows semver, with one clarification that matters before 1.0: **the manifest and
lockfile formats are not stable yet.** `lockfileVersion` exists so a change can be detected
rather than silently misread, and a `0.x` release may bump it.

## Unreleased

### Fixed

- **Resolution opened one socket per package and got slower the wider the graph
  was.** Metadata fetching walks the dependency graph breadth-first, and each round
  was a bare `Promise.all` over every package at that depth — for a project with 506
  direct dependencies, 506 simultaneous requests. Measured against the live registry
  on 150 packages, best of two runs:

  ```
   8 -> 5.0s     16 -> 2.8s     32 -> 1.8s     64 -> 7.4s     unbounded -> 21.9s
  ```

  The curve is a cliff, not a slope, and unbounded sat at the wrong end of it.
  Requests are now bounded at 32. On a 506-package graph, resolution went from
  **44.8s to 8.9s**. Downloads were already bounded; metadata was not, and on a wide
  graph it is the larger of the two because every package is asked about while only
  the chosen ones are downloaded.

- **A package containing a file over 512 KiB could not be installed** (RN-6). fflate's
  async `unzip` hands entries above that to a worker, and under Bun the worker returns
  nothing — the callback reports `undefined is not an object (evaluating 'dat.length')`.
  The same archives inflate correctly under Node, and the boundary is the *uncompressed*
  size, so a kilobyte of compressed data that expands past the threshold fails too. Rarn
  ships as a Bun binary, so this was every user, on every version.

  It surfaced as `RN0310: the download may be corrupt. Try again` — advice that cannot
  work, on archives that are not corrupt. `4x8matrix/class-index@3.0.0` carries a 2.7 MB
  API dump and could not be installed by any release of Rarn; `wally install` handles it.
  Inflation is now synchronous. The parallelism it cost was measured at 23ms for that
  archive, against a class of package that could not be installed at all.

## Unreleased

### Fixed

- **The require harness reported a realm holding only cross-realm shims as broken.**
  Placement resolves to the widest requester, so a package declared under
  `serverDependencies` that a shared package also needs is stored in the shared realm —
  and the server directory then keeps only the shim pointing across at it, with no
  `_Index` at all. The harness exited 1 on that, calling a correct install broken. It
  now says what it found and carries on; a realm with neither an `_Index` nor any shim
  still fails, because nothing to check is not the same as nothing being there.

- **A `place` path with a space in it produced Luau that does not parse.** `place` is
  derived from the project's Rojo files when the manifest does not declare it, and an
  *instance* name has none of Luau's restrictions — Rojo is perfectly happy with
  `"My Packages"`. The generated cross-realm shim pasted the path in verbatim and came
  out as `require(game.ReplicatedStorage.My Packages._Index[...])`, so the install
  finished green, the tree was correct, and the file failed to parse in Studio. Segments
  a dot cannot reach are now bracketed, and only those, so an ordinary path still reads
  as `game.ReplicatedStorage.Packages`.

- **A cross-realm link into the dev realm would have named the wrong service.**
  `requirePlacePath` took any placement and fell through to `serverPackages` for
  anything that was not `shared`. Unreachable today — placement resolves to the widest
  requester, so nothing outside dev can point into it — but the signature now says so
  and the boundary checks it, because unreachable today and unreachable tomorrow are
  different claims.

- **An alias only has to be unique within one manifest section.** Root shims are
  written per section — `dependencies` into the shared realm directory,
  `serverDependencies` into the server one — so two aliases only land on the same path
  when they came from the same section. Pooling all three refused a shared
  `@evaera/promise` beside a server `@nezuo/promise`, which are different files in
  different directories, and refused the same package declared in two sections, which
  the linker explicitly supports and which the pooled check read as a collision of a
  package with itself. The message now names the section, because the same alias is
  fine in another one.

- **`rarn publish` could ship another package manager's install directory.** The
  built-in exclusions cover Rarn's own realm directories, which it derives from
  `packageDir` — but not Wally's `Packages/`, `ServerPackages/` and `DevPackages/`,
  which a migrated project still has sitting in it. Publishing the first real package
  produced an archive of 388 files, 339 of them a `DevPackages/` nobody meant to ship,
  and a published version cannot be taken back.

  An installed tree is now recognised by shape: any directory holding an `_Index/` is
  excluded along with the shims beside it. Matching the names would have been the
  obvious fix and the wrong one — a project whose *source* lives in `Packages/` would
  then publish nothing, and `include` cannot rescue a whole directory because only an
  exactly-named path overrides a default exclusion.

## 0.1.1 — 2026-08-22

**0.1.0 is withdrawn; this replaces it.** R2, a research pass over what a workspace would
mean on this platform, found five defects instead — one of which deleted a directory the
user wrote. Each was reproduced before it was fixed, and two turned out not to be what the
report said they were. Nothing here changes the manifest or lockfile format.

### Install

```toml
# rokit.toml
[tools]
rarn = "Hawakiki/roblox-rarn@0.1.1"
```

```bash
rokit trust Hawakiki/roblox-rarn
rokit install
```

The trust step is Rokit's own policy — without it the install stops with "has not been
marked as trusted". It is asked once per machine.

### Added

- **Duplicates are now checked across every tree that lands in one DataModel** (RN-3).
  Constraint 1's boundary is a Lua environment, and a Rojo project file can mount trees
  from anywhere — so two projects installed side by side, each resolving correctly and
  each reporting `no duplicates`, put two ModuleScript instances of one package into one
  place. Every per-project check is blind to it: both lockfiles are right.
  `rarn dedupe` now reads the project files that mount this project's install directories
  and reports what else is in the same DataModel (`RN0213`), naming each version and the
  tree it came from; `rarn install` warns about the semver-compatible case, which is the
  one that breaks singletons. Nothing here reads a lockfile, so a Wally install and a tree
  Rarn never made count the same — as they do to Rojo. It reports rather than resolves:
  converging the ranges or separating the places is a decision about layout.

  Two limits, both deliberate. The search starts at a repository root and nowhere else,
  because that is the only boundary the project actually stated. And it reports only places
  that mount this project's own realm directories, so an unrelated sibling never appears.

### Fixed

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

- **`place` was derived from one fixed filename, and found nothing in the projects
  that needed it** (RN-4). Only `<projectDir>/default.project.json` was read, but Rojo's
  convention is any `*.project.json`, and of the 30 multi-place repositories surveyed for
  R2, 25 have no `default.project.json` at the root — they name the file per place or nest
  one per place under `places/`. Those are exactly the projects with a cross-realm link to
  derive, and they got `RN0031` asking them to write `place` by hand. Every
  `*.project.json` down to three levels is now read (skipping dot-directories,
  `node_modules`, the realm directories and `_Index`), and `$path` is resolved against the
  file's own directory, so a nested place file reaching `"../../Packages"` matches. Where
  two project files agree on a realm the path is derived; where they disagree nothing is
  derived and both paths are printed, because no single absolute path is right for two
  DataModels.

- **The unmounted-realm warning was silent for a library's project file** (RN-4).
  `{ "tree": { "$path": "src" } }` mounts nothing, and that was treated as *nothing was
  checked* — so the warning CLAUDE.md promises ("a realm directory the project file does
  not mount is a warning, not an error") never fired in the shape every publishable
  package uses. Reading a project file and finding nothing in it are now separate facts.
  With no project file at all it stays silent, since then there is no place for the
  warning to be about.

- **The require harness could not check a cross-realm shim, and reported the correct
  form as broken** (RN-2). A shim crossing realms names an absolute DataModel path,
  and the harness's `game` stub returned a bare table, so the path resolved to nil.
  `verify.luau` now takes `--mount=<DataModelPath>=<dir>` and the runtime builds
  `game` from those mounts, wrapping them through the same proxy table as the primary
  realm — so a package reached across a realm boundary still compares equal to itself.
  Without a mount the check is reported as *not verified* rather than failed, and the
  harness test now exercises both paths, which CI never did.

## 0.1.0 — 2026-08-21 (withdrawn)

**Withdrawn on 2026-08-22 and not installable.** `rarn install` could replace a directory it
did not create: on a case-insensitive filesystem `packageDir: "Packages"` names a `packages/`
source tree, and `rarn import` writes exactly that name. The release was deleted the day after
it went out — four asset downloads, all our own. The tag stays as history. Use 0.1.1.

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
