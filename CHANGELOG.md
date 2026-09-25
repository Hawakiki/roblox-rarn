# Changelog

Notable changes per release. Dates are release dates.

Rarn follows semver, with one clarification that matters before 1.0: **the manifest and
lockfile formats are not stable yet.** `lockfileVersion` exists so a change can be detected
rather than silently misread, and a `0.x` release may bump it.

## Unreleased

### Fixed

- **`rarn cache clean` no longer exits 0 having done nothing when stdin is not a
  terminal** (RN-14). It printed the confirmation, waited on input that had already
  ended, and exited successfully with the cache untouched — the same shape `rarn init`
  had, in the one other command that asks a question. It now refuses with `RN0004` and
  names `--yes`.

  `init` fills in its defaults in this situation and this does not, because the two
  directions do not cost the same. Guessing wrong at `init` writes a file that can be
  edited; guessing wrong here sends every project on the machine back to the network
  for its next install.

  Pressing Ctrl+D at the question is now read as declining, rather than leaving the
  same unanswered promise behind.

- **`rarn cache verify --json` now fails when a digest does not match** (RN-15). It
  listed the mismatch in the JSON body and exited 0, while the human output exited 1
  on the same cache. `--json` is the form a script reads, and a script reads the exit
  code — so the one finding here that could be an attack was reported loudly to a
  person and silently to the caller built to catch it.

- **Two packages whose aliases differ only in case are now refused** (RN-16). The
  uniqueness rule compared alias strings case-sensitively and the filesystem does not:
  `EnumList.luau` and `Enumlist.luau` are one file on Windows and on a default macOS
  volume, so one package's shim overwrote the other's. The install reported success,
  `rarn.lock` was correct, and `rarn doctor` could not see it — all that remained was
  `require(Packages.EnumList)` returning whichever package was written last.

  Both spellings in that example are what Rarn derives on its own, so writing no
  `aliases` entry was not a way to avoid it. Found by counting during the R3 performance
  research: `link` reported writing 1,136 shims and 1,131 files existed.

  The message names both spellings rather than the folded form, because two names that
  are visibly different colliding reads as a bug in Rarn unless it says why. The
  replacement it suggests is now checked against the aliases already in the section, so
  the JSON it prints can still be pasted.

  This is stricter than a case-sensitive filesystem needs, deliberately: a manifest that
  installs on Linux CI and shadows a package on the author's Mac is worse than one that
  is refused in both places.

- **`rarn.lock` is now ordered the same way on every machine** (RN-17). The nested maps
  (`dependencies`, `requestedBy`, the `root` sections) were collated by the operating
  system's locale while the `packages` map beside them was not, so one file followed two
  orders and the same install could write a different lockfile on, say, a Czech-locale
  machine than on CI. Everything Rarn writes, packs or prints as `--json` now uses one
  plain code-unit order, the generated `wally.toml` included.

  Existing lockfiles stay valid and `--frozen-lockfile` accepts them. The first install
  may rewrite one with its keys reordered, once — when two aliases differ only in case or
  in `_`/`-`, or when one package is declared with two differently spelled ranges. A CI
  job that checks for a clean tree after installing will see that diff one time.

### Changed

- **The per-package copy out of the cache now runs eight at a time.** It was one package
  after another, and the cost of that copy is per *file* rather than per byte — on Windows
  each one pays an open, a write, a close and an on-access scan, none of which the process
  can overlap with anything while it waits.

  Measured on the shipped binary, 506 packages, warm cache and lockfile: 5,133 → 4,024ms
  (21.6%), arms run on/off/on. In TypeScript, 4,297 → 2,848ms (33.7%). At 49 and 52
  packages it is 30.7% and 30.6%; at 6 packages the arms overlap, so nothing is claimed
  there.

  Combined with the deferred delete below, a repeat install of that graph went from
  6,352 to 4,024ms with the binary — 36.6%. The two savings were measured as a full 2×2
  and are independent to within 52ms, so making the build faster did not stop the delete
  hiding behind it.

  The install output is byte-identical, and results are consumed in input order rather
  than completion order, so the lockfile and every shim are unchanged.

- **`mapWithConcurrency` now waits for work already in flight before a failure
  propagates, and reports the lowest-indexed failure rather than the fastest.** The first
  half is a defect the concurrent copy would otherwise have introduced: a caller's
  cleanup runs in a `finally`, and returning while workers were still writing left `link`
  with a staging directory it had just deleted. The second half is what keeps a sorted
  input meaningful — the same package is named first on every run.

- **A repeat install is about 20% faster, because deleting the previous tree moved off
  the critical path.** `swapIn` used to delete the tree it had just retired, as the last
  thing in the install — 2,049ms of a 6,517ms repeat install of a 506-package graph,
  every millisecond of it spent after the tree on disk was already correct. The install
  that retires a tree now leaves it, and the next one deletes it *while it builds*, where
  it hides inside work that was happening anyway.

  Measured on the shipped binary, 506 packages, warm cache and lockfile: 6,352 → 5,057ms
  (20.4%), with the arms run on/off/on to rule out drift. In TypeScript the same change
  measures 31.9%, and the gap between the two is not explained; the binary is what you
  run, so 20.4% is the number. Smaller graphs behave the same way: 6 packages 18.4%,
  49 packages 29.6%, 52 packages 30.4%, all measured in-process and none overlapping.

  **What this costs is one directory.** Between installs the project now holds the
  previous tree as well as the current one — 43MB at 506 packages, proportionally less
  below that. `rarn init` already lists both scratch names in `.gitignore`, and `rarn
  publish` now excludes them by name.

  The safety story does not change, except to improve: the tree you had survives longer,
  not less. An interrupted install still leaves the previous install intact.

### Added

- Tests for `rarn cache`, which had none. It was the second command carrying its
  behaviour in `cli/` rather than in a layer, and the second one to ship a defect
  because of it.

## 0.2.0 — 2026-08-22

**Everything below has been sitting unreleased, and one of it matters more than the rest:
RN-6 was recorded as fixed in 0.1.1 and was not.** The fix commit landed after the tag, so
anyone on 0.1.1 still cannot install a package containing a file over 512 KiB — they get
`RN0310 … The download may be corrupt. Try again`, on an archive that is not corrupt.
Reproduced against the released binary before writing this.

The formats are unchanged: `rarn.json` and `rarn.lock` written by 0.1.1 load here and
nothing needs migrating. The minor bump is for what a shim looks like — packages that
export types now get several lines instead of one — and for how much `rarn doctor` output
changes on a real project.

Most of this came from a session that had never seen Rarn building a React project in
another folder and writing down where it got stuck, which found four defects and three
documentation errors, and from answering "how realistic is the harness, roughly?", which
found three more.

### Added

- **A link shim now forwards the package's exported types.** Luau carries a required
  module's *value* through a link and none of its type aliases, so
  `require(Packages.React)` gave a `React` whose `createElement` type-checked and whose
  `React.Node` was `Unknown type 'React.Node'` — at every call site, which makes a
  `--!strict` signature against any typed package impossible to write. 300 of the 584
  packages in a warm cache export types this way, 1943 aliases between them, and Wally
  has the same hole.

  A shim for such a package binds the module and re-exports what it declares, generic
  parameters and their defaults included:

  ```lua
  local Module = require(script.Parent._Index["jsdotlua_react@17.2.1"]["react"])

  export type Node = Module.Node
  export type PureComponent<Props, State = nil> = Module.PureComponent<Props, State>

  return Module
  ```

  Only the entry module is read, and anything not understood is left out rather than
  guessed at: a missed type costs the annotation someone was going to write by hand,
  while a wrongly forwarded one puts an error in a generated file they did not write.
  A declaration whose default names a type the package keeps private is dropped whole,
  and the drop repeats to a fixed point because dropping one can strand another. A
  package that exports no types keeps the one-line shim it always had.

  Measured on the 52-package React project that reported the problem: 211 of 224 shims
  forward types, `luau-lsp analyze` reports nothing across the whole install tree, and
  the hand-written façade the project had needed — declaring `Node` and `Context<T>` as
  `any` because the real ones could not be reached — type-checks against the real types
  instead. Reading one entry file per package costs about 50ms on that install.

  Then checked the other way, because a change that rewrites every shim deserves it:
  shims generated for all 584 packages in a warm cache — 578 written, 318 of them
  forwarding types — and `luau-lsp analyze` run over the lot. **All 318 are clean.** The
  13 diagnostics that remain are on one-line shims that forward nothing, and are about
  the packages' own contents (`Module does not return exactly 1 value`), not about
  anything Rarn writes.

  That sweep is also what caught the one real defect: a function type in a generic
  default — `<Listener = (...any) -> ()>`, from `developmentfurthered/signal` — ended
  the parameter list at the `>` of the arrow, and the shim came out as unparseable Luau.
  Two packages of the 318, and nothing smaller than the whole registry would have found
  it.

### Fixed

- **The require harness had no `:WaitForChild`** (RN-11), which is how most of the
  registry navigates its own tree — 3256 calls across the 584 packages in a warm
  cache, against 1052 for `:FindFirstChild` and none of the ten read-only queries
  implemented at all. Nothing in the default checks noticed, because Rarn's own shims
  index with `.Name` and `["Name"]`; it meant `--execute` could not load the JS-port
  half of the registry, which is the half whose install correctness is hardest to
  reason about by eye.

  All ten are implemented now (`WaitForChild`, `FindFirstChild`,
  `FindFirstChildOfClass`, `FindFirstAncestor`, `GetChildren`, `GetDescendants`,
  `IsA`, `IsDescendantOf`, `IsAncestorOf`, `GetFullName`) — none of them engine
  behaviour, each a pure function of the tree the harness already holds. `:Destroy`
  and `:Clone` stay out on purpose. Measured over two real install trees, packages
  that load under `--execute` went from **5/38 to 34/38**; the four that remain are
  `Instance.new` and a Luau string require, which are the engine boundary rather than
  a gap.

- **A module that failed once was reported as a cyclic require ever after** (RN-12).
  The in-flight flag was cleared after the chunk returned and not when it threw, so
  the second attempt met its own leftover marker. Two lines reproduce it. It bites
  hardest where it is least visible: `verify.luau` pcalls each shim and carries on, so
  the first genuine failure in a run silently rewrote the diagnosis of everything
  downstream of it — the wrong cause, in place of the one that was there.

- **The `game` stub was a hard error in the one place it existed to prevent one**
  (RN-13). Its own comment said unmounted paths stay permissive so that package code
  calling `game:GetService` at module scope does not fail — but every key returned a
  table, and calling a table is an error. 7 of 33 failed package loads under
  `--execute` were this. Stubs are callable now, so a stub yields another stub. That
  buys reach, not fidelity: a package that merely *touches* the engine gets past it,
  and one that needs the engine to answer truthfully is still not being tested.

- **`rarn doctor` could not read the require form that most of the registry uses**
  (RN-7). Package sources reach their dependencies four ways —
  `.Name`, `["Name"]`, `:WaitForChild("Name")`, `:FindFirstChild("Name")` — and the
  scanner knew the first two. The JS-port half of the ecosystem (react-lua, jest-lua,
  luau-polyfill, every `jsdotlua/*` package) writes the third and nothing else, so on a
  real 52-package React install **1655 of 1663 requires were unreadable**. That did not
  show up as "could not check"; it showed up as 310 lines reporting a correct install's
  dependencies as declared-but-never-required.

  All four spellings now read as one operation, and only the first lookup past the
  parent chain counts as the dependency, so `script.Parent.Parent.Foo.Bar` reaches
  `Foo` instead of being unreadable. A dot inside an instance name survives too: Rojo
  strips one extension, so `ReactFiberWorkLoop.new.lua` is an instance called
  `ReactFiberWorkLoop.new`, and the name used to be erased as punctuation.

  On the same install: **1663 unreadable requires → 10**, output 310 lines → 46, and
  every one of the remaining 10 is genuinely dynamic (Luau string requires, and names
  built at runtime in test mocks).

- **`rarn doctor` understated what it had read** (RN-10). The summary summed files over
  the packages it had something to *report* on, then printed that beside the count of
  all packages — "scanned 212 files across 52 packages" for a run that read 444. The
  sentence read as coverage while measuring noise, and got quieter as the tool got
  better.

- **`rarn init` did nothing, silently, whenever stdin was not a terminal** (RN-8) —
  every script, every CI job, every non-interactive caller. It printed the first prompt,
  wrote no manifest, said nothing, and exited 0, which is the one failure
  indistinguishable from success. It now uses the defaults and says so. Ending the input
  mid-prompt (Ctrl+D) used to do the same thing and now reports `RN0004`.

- **`rarn init`'s Rojo advice was silent in exactly the case that needed it** (RN-9).
  An unmounted package directory produces no error anywhere, so `init` offers the
  snippet to paste — but it skipped that when there was no project file at all, which is
  the state every first `rarn init` is in. Walked in the field in this order: `init` in
  an empty directory (silence), then `rarn add -D`, which failed with `RN0031` because
  there was still nothing to derive `place` from.

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

- **A package containing a file over 512 KiB could not be installed** (RN-6). **This was
  recorded for a while as having shipped in 0.1.1, and it did not** — the fix commit is
  after the tag, so anyone on 0.1.1 still cannot install one. Reproduced against the
  released binary with a cold cache; it fails with `RN0310 … The download may be corrupt.
  Try again`, which cannot work because the archive is not corrupt. fflate's
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

### Changed

- **`RN0012` pointed at a file nobody has.** Its advice ended *"The full schema is in
  schemas/rarn.schema.json"* — a path in this repository, offered to people who
  installed a binary. It now links to the schema, and says more before needing to: an
  unknown field gets the field it was probably reaching for (`dependancies` → *did you
  mean 'dependencies'?*), or the list of what that object does take, when the name was
  invented rather than mistyped.

- **`place.devPackages` is answered instead of merely refused.** Three dependency
  sections go in and `place` has two entries, so people write a third; "unknown field"
  is correct and leaves the harder half — where dev packages actually land. The message
  now names `<packageDir>_DEV`, says to mount it wherever the test project likes, and
  explains why nothing ever reaches *into* dev: a package lands in the widest realm that
  asked for it, so anything requiring a dev package would have pulled it out of dev
  already.

### Documentation

- **The install instructions produced a tool that could not be run.** README showed the
  finished `rokit.toml` but not the command, and `rokit add Hawakiki/roblox-rarn` names
  the tool after its repository — so `rarn` fails with *"Failed to find tool 'rarn' in
  any project manifest file"* while a `rarn` shim sits in `~/.rokit/bin` looking
  installed. The error reads as *add it*, so the obvious next move is to add it again,
  which changes nothing. The alias is now in the command: `rokit add
  Hawakiki/roblox-rarn rarn`.

- **Where the three realm directories come from, and which of them need a `place`.**
  `packageDir` plus `_SERVER` and `_DEV` was visible only as a diagram of the default,
  so a project with `packageDir: "Packages"` had to guess `Packages_DEV` — or, as
  happened, grep the generated shims for it.

- **Packages that ship their own tests.** A module root may contain `init.spec.lua`, and
  Rarn copies what the author declared rather than second-guessing it. Harmless as
  bytes; not harmless if a test framework's default pattern discovers the package's
  specs as yours. The fix belongs in `globIgnorePaths`, and the README now says so.

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
