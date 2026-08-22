# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Rarn is

A CLI package manager for Roblox projects. It installs packages from the **Wally registry**
(`api.wally.run`) but uses its own `package.json`-shaped manifest (`rarn.json`), its own
lockfile (`rarn.lock`), and a global cache.

Written in **TypeScript, run by Bun**. Roblox/Luau is the *target*, never the
implementation language — no Luau code exists in this repo except the `.luau` link shims
that Rarn *generates* as install output.

## Commands

```bash
bun install                          # install dev dependencies
bun run src/cli.ts <args>            # run the CLI in development
bun test                             # run the whole test suite
bun test path/to/file.test.ts        # run one test file
bun test -t "resolves ranges"        # run tests matching a name
bun run typecheck                    # tsc --noEmit
bun run format                       # biome check (formatting + fast rules)
bun run format:fix                   # biome check --write
bun run lint                         # eslint, type-aware rules
bun run check                        # format + lint + typecheck + test, in that order
bun run build                        # bun build --compile -> dist/rarn(.exe)
bash scripts/smoke.sh dist/rarn.exe  # prove a compiled binary actually starts
```

`bun run check` is what the pre-commit hook runs, and what CI runs. Run it before
committing rather than discovering it at commit time.

`scripts/smoke.sh` exists because a compiled binary can build cleanly and still fail
at launch — the JSON schemas arrive through import attributes and `--bytecode` rewrites
the module graph, so the failures show up on the first run, never in the build log.

### Verifying an install

Roblox-side tools come from `rokit.toml` and are needed only to check output, never
to build Rarn. `~/.rokit/bin` must be on PATH, and the shims resolve against that file.

```bash
lune run tests/roblox/verify.luau -- <install-dir> [<realm>] [--mount=<path>=<dir>]... [--execute]
```

Reimplements Roblox's `require` — instance-based lookup, per-instance caching — over
a real install tree. It answers the two questions a file-tree assertion cannot: does
each shim reach a real ModuleScript, and does one package reached by two paths come
back as **one instance**. Two copies look identical on disk and only diverge at
runtime, when every singleton inside quietly becomes two.

`bun test` runs it automatically on a synthetic tree, with three deliberately broken
trees alongside — a harness nothing can fail is worth nothing.

A **cross-realm shim needs `--mount`**. It names an absolute DataModel path out of
`place`, so there is nothing to resolve against unless the sibling realm is mounted:

```bash
lune run tests/roblox/verify.luau -- <proj>/RARN_MODULE_SERVER RARN_MODULE_SERVER   --mount=game.ReplicatedStorage.RARN_MODULE=<proj>/RARN_MODULE
```

Mounted trees wrap through the same proxy table as the primary realm, so identity
still means what it means. Without a mount the check reports as **not verified**, never
as a failure — until 2026-08-22 it reported the correct shim as broken, which is worse
than not checking, and CI never invoked it this way to notice.

It **skips, loudly, when `lune` is absent**, since nothing about building Rarn needs a
Roblox-side tool. CI installs `lune` rather than accepting the skip: this is the only
test that can tell one shared package from two copies of it, and a harness that quietly
did not run reads exactly like one that ran and passed.

`rojo sourcemap` is the **second** Roblox-side check, and it answers a different question: not
whether requires resolve inside a realm, but whether the realm is where Rarn told the shims it
would be. `tests/place-sourcemap.test.ts` compares the DataModel path derived from a project
file against the instance tree Rojo really builds — the closest thing to asking Rojo directly,
with no Studio and no network. It skips loudly when `rojo` is absent, and CI installs it.

Package code is **not** executed by default. A real package calls `game:GetService`
and `task.defer` at module scope, so running it measures stub completeness rather
than install correctness; package modules resolve to a per-instance sentinel instead.
`--execute` opts in.

**Where the model stops is a decision, and the line is drawn at mutation.** The
read-only tree queries are implemented — `WaitForChild`, `FindFirstChild`,
`FindFirstChildOfClass`, `FindFirstAncestor`, `GetChildren`, `GetDescendants`, `IsA`,
`IsDescendantOf`, `IsAncestorOf`, `GetFullName` — because none of them is engine
behaviour: each is a pure function of the tree already built, and `:WaitForChild("x")`
is `["x"]` with a different spelling. Package code leans on them heavily (6171 calls
across the 584 packages in a warm cache, `:WaitForChild` alone 3256), and without them
`--execute` could not load the JS-port half of the registry at all.

`:Destroy` and `:Clone` are common too (876 and 132) and are refused: a tree the code
under test can mutate would put the identity guarantee this harness exists to check at
the mercy of the thing being checked. Beyond that — `Enum` (4165), `Instance.new`
(1845), `task` (1663), `RunService` (1644) — is the engine, and stays out. Adding
stubs there widens the area in which a *passing* harness can be silently wrong, which
is the one direction that costs more than it buys.

Two places where the model knowingly differs from the engine, both commented at the
source: `GetChildren` sorts by name, because a tree read off a filesystem has no
insertion order to recover and a result that depends on `readDir` order is worse than
one that is knowingly ordered differently; and `GetFullName` starts at whatever tree
was loaded rather than at `game`.

`tests/roblox/emulate-selftest.luau` checks the model against its own claims, which is
a different question from every other test here — those ask whether a tree is correct
*under* the model. Both defects that made it necessary were the harness answering
confidently about something it had not implemented.

**This does not replace `test/roblox/`.** The harness proves the tree is consistent
under a *model* of Roblox. If the model is wrong the harness passes and Studio breaks,
so the manual check stays — run it whenever the linker changes.

#### The model has been checked against real Studio, once

2026-08-21, over the Studio MCP bridge, on a `rojo build` of `test/roblox/` (knit → comm →
promise/option/signal). The harness scored 17/17 on the same tree, and Studio agreed on every
point:

| claim | held in Studio |
|---|---|
| two copies of one source are two tables | yes — this is why dedupe is correctness, not disk |
| one instance required twice is one table | yes |
| `script.Parent.Parent.X` reaches a sibling | yes |
| an instance may be named `luau-polyfill`, reached by `Parent["luau-polyfill"]` | yes |
| three shims for one package return **one** table | yes, and the shim instances really are distinct |
| a package reached across realms is still that one table | yes |
| `Knit.Util` is the `_Index` entry folder | yes — `Knit.Util.Name == "sleitnick_knit@1.7.0"` |
| Knit, Promise and Signal actually run | yes — `Promise.resolve(42):awaitStatus()` → `Resolved 42` |

Two things that only a real DataModel could show:

- **A `_Index` Folder and an `_Index` ModuleScript coexist under one parent.** Roblox does not
  complain; `FindFirstChild` returns whichever was added first and the other is simply
  unreachable. An alias of `_Index` is therefore a silent shadowing, not an error.
- **A wrong `place` fails with nothing useful.** Every cause — wrong folder, missing version,
  misspelt service — produces the same `Requested module experienced an error while loading`.
  The real message (`Packages is not a valid member of ReplicatedStorage`) is one layer down,
  visible only as a second line in Output. Nothing before runtime sees it: the install
  succeeds, the tree is correct, and the harness passes. That is the whole argument for
  validating `place` at install time.

`wally install` on an equivalent `wally.toml` is the other useful comparison: the
skeleton and shim bodies should match, and only pruning should differ.

`bun build --compile --target=bun-windows-x64|bun-darwin-arm64|bun-linux-x64` cross-compiles
from any host, **except that a Windows target must not be cross-compiled with `--bytecode`**.
`bun-windows-arm64` is not supported by Bun. Native `.node` addons do not cross-compile, so
**keep every dependency pure JS**.

The Windows exception is measured, not assumed. On Bun 1.3.14, a `bun-windows-x64` binary
built on ubuntu with `--bytecode` segfaults at startup — on `--version`, before any Rarn
code runs. The same host with `--bytecode` removed passes every smoke check; the same host
targeting `bun-darwin-arm64` with `--bytecode` is fine on macOS; and building on Windows
with `--bytecode` is fine too. So the broken combination is exactly *Windows target +
cross-compiled + bytecode*.

Bytecode is worth keeping — it moves startup from 178ms to 152ms — so CI builds the Windows
binary on a Windows runner and cross-compiles the other two from ubuntu. If Bun fixes this,
the giveaway will be the `smoke` job passing after moving `windows-x64` back to ubuntu, not
this paragraph.

**A library can behave differently under Bun than under Node, and the tests will not see
it.** fflate's async `unzip` hands entries above 512 KiB to a worker, and under Bun that
worker returns nothing — the callback reports `undefined is not an object (evaluating
'dat.length')`. Measured: Bun fails at 600,000 bytes and passes at 500,000; Node passes at
every size. The boundary is the *uncompressed* size, so a kilobyte of compressed data that
expands past it fails too.

Rarn ships as a Bun binary, so this was every user of every version, surfacing as
`RN0310: the download may be corrupt. Try again` on archives that were not corrupt.
Inflation is synchronous now. Two things follow for anything added later: **run the suite
on the runtime that ships**, which the project already does, and remember that doing so is
not enough by itself — the fixture also has to cross the boundary that matters, and no test
here held a file that large until one was written on purpose.

### CI

`.github/workflows/ci.yml`. Three jobs, and **each one's matrix axis is different** — the
temptation to merge them is the thing to resist:

| 잡 | axis | why that axis |
|---|---|---|
| `check` | `os: [ubuntu, windows]` | `renameIntoPlace` rests on "Windows will not rename onto an existing path". A Linux-only CI never executes that branch. Development happens on Windows, so Linux is the *un*tested side |
| `build` | target (Windows native, other two cross-compiled from ubuntu) | see above |
| `smoke` | runner OS ↔ artifact (macOS pinned to `macos-26`; the artifact is arm64 and `macos-latest` is GitHubs to change) | building is not running. The ubuntu-built Windows binary compiled cleanly and crashed on launch; only this job saw it |

`RARN_NO_NETWORK=1` is set for the whole workflow. Every test injects its own fetch, so the
suite is offline by construction — but that is a convention, and one test with a real request
would pass locally, pass review, and then fail whenever the registry has a bad day. With the
variable set it fails immediately with `RN0130`. Only the global fetch is wrapped; an injected
one is a stand-in by definition, so the guard never touches the suite.

`scripts/smoke.sh <binary>` runs anywhere, not just in CI.

## Hard constraints — read before designing anything

These are measured facts about the target platform and the Wally API, not preferences.
Violating any of them produces a package manager that silently installs broken packages.

### 1. Duplicate packages are a correctness bug, not wasted disk

Roblox's `require` takes an **Instance**, not a path string, and caches **per ModuleScript
instance**. Two copies of the same source are two separate modules with separate state, so
any singleton inside a package (signal registry, symbol table, class identity) breaks.
Dedupe is therefore mandatory, not an optimization.

There is also no resolution algorithm — no walking up directories looking for
`node_modules`. Luau can only navigate the tree it is given (`script.Parent.Parent.Foo`).

**The boundary is one DataModel, not one project.** This is the constraint's actual scope
and it took R2 to state it: a Rojo project file is free to mount trees from anywhere, so two
projects installed side by side, each resolving correctly and each reporting `no duplicates`,
put two ModuleScript instances of one package into one place. Measured, with `rojo sourcemap`
on the trees two real installs produced:

```
ws.ReplicatedStorage.Alpha._Index.evaera_promise@3.2.0.promise
ws.ReplicatedStorage.Beta._Index.evaera_promise@3.2.1.promise
```

Every per-project check is blind to that by construction — the lockfiles are both right.
`src/doctor/places.ts` is the one thing that looks at it: it reads the *project files* rather
than any lockfile, so a Wally install and a tree Rarn never made both count, exactly as they
do to Rojo. It reports (`RN0213`) and does not resolve; converging the ranges or separating
the places is a decision about layout, not one Rarn can make.

Two rules keep it from becoming noise. It searches only from a **repository root**, because
that is the one boundary the user actually drew — an earlier version fell back to "one level
up" and scanned every unrelated sibling in a shared folder. And it reports only places that
mount **this project's own install directories**, since the question is what shares a
DataModel with these packages, not what duplicates exist somewhere nearby.

### 2. The `_Index` + link-shim layout is forced, not chosen

Downloaded package source contains **hardcoded** `require(script.Parent.Parent.Alias)` calls.
The two-level shape below must be preserved exactly or those calls resolve to `nil`:

```
RARN_MODULE/                       <- shared realm
  Promise.luau                     <- shim; only direct deps appear at top level
  _Index/
    evaera_promise@4.0.0/
      promise/                     <- real source, exactly one copy
        init.luau
    sleitnick_knit@1.7.0/
      knit/
      Promise.luau                 <- shim; sibling of the source folder
RARN_MODULE_SERVER/                <- server realm, same shape
RARN_MODULE_DEV/                   <- dev realm, same shape
```

```lua
-- RARN_MODULE/Promise.luau
return require(script.Parent._Index["evaera_promise@4.0.0"]["promise"])

-- RARN_MODULE/_Index/sleitnick_knit@1.7.0/Promise.luau
return require(script.Parent.Parent["evaera_promise@4.0.0"]["promise"])
```

The folder names `RARN_MODULE` and `_Index` are ours to rename. **The shape is not.**
A dep link must always sit as a *sibling* of the package's own source folder.

The `_Index` entry folder is `{scope}_{name}@{version}`, and the source folder inside it is
the **package name** — `default.project.json`'s `name` field is *not* what decides it, even
though the two always agree (the registry rewrites that field to match at publish time).

Two packages resolving to one version share one `_Index` folder, so their shims resolve to
the same ModuleScript instance — that is how dedupe is enforced structurally rather than by
convention.

### 2a. Realms are three sibling directories, and crossing them needs absolute paths

Each realm gets its own top-level directory with its own `_Index`. They are siblings, never
nested, because each is synced to a different Roblox service.

A shim can only walk relatively *within* one realm. When a server or dev package depends on a
shared one, the two directories sit under different services, so the shim must name an
absolute DataModel path taken from the manifest's `place`:

```lua
return require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"]["promise"])
```

`place` is **derived from the project's Rojo files when the manifest does not declare it**, by
walking each tree for a node whose `$path` is a realm directory and reading the DataModel path
back off the trail. It cannot be guessed from `packageDir`: the instance name and the folder
name are independent, and real projects use that (`"SharedPackages": { "$path": "Packages" }`).

If a cross-realm link is needed and neither source supplies the path, fail with an explanation
of what to add — there is no way to synthesize it.

Five things the project-file walker has to get right, all taken from real files rather than
imagined:

- **A service node need not carry `$className`.** `"ReplicatedStorage": { "Packages": {...} }`
  is enough, and requiring the field silently skips the most common template.
- **`$path` is not always a string.** `{ "optional": "Packages" }` is Rojo's form for a path
  that may not exist yet — which is precisely what a project using a package manager writes.
- **A node can carry `$path` *and* children.** Stopping at the first `$path` misses whatever is
  below it.
- **The file is not called `default.project.json`.** Rojo's convention is any `*.project.json`,
  and of the 30 multi-place repositories surveyed for R2, **25 have no `default.project.json` at
  the root** — the file is named per place (`client.project.json`) or nested one directory per
  place (`places/lobby/default.project.json`). Reading one fixed name found nothing in exactly
  the projects that have a cross-realm path to derive. Every `*.project.json` down to three
  levels is read, skipping dot-directories, `node_modules`, the realm directories, and `_Index`
  — an install holds one project file per package and none of them describe this project.
- **`$path` is relative to the file, not to the project root.** A nested place file reaches a
  root-level realm as `"../../Packages"`, so the string has to be resolved against the file's own
  directory before it is compared. Matching the literal text worked only for a file sitting at
  the root, which is the arrangement those 25 repositories do not use.

Two project files are two DataModels. Where they agree on a realm — measured: **12 of 12**
multi-place repositories that mount a dependency directory mount it at the same DataModel path
in every place — the agreed path is derived. Where they disagree, no path is right for both, so
nothing is derived and the disagreement is printed: guessing produces the opaque Studio failure
described above, while not deriving produces `RN0031`, which says what to add.

When the two sources disagree the manifest wins and the disagreement is printed. Someone who
wrote a path down meant it; but one of the two is wrong, and the runtime will not say which —
see the Studio measurements above for what it says instead.

**A realm directory no project file mounts is a warning, not an error.** The install succeeds,
the tree is right, and the packages simply never reach Studio. This is exactly what a Wally
import produces: Wally used `ServerPackages`, Rarn derives `Packages_SERVER` by suffix, and the
old Rojo entry does not cover it.

The warning fires whenever a project file was **read**, which is not the same as one having
mounted something. A library's project file is `{ "tree": { "$path": "src" } }`; walking it finds
nothing, and treating "found nothing" as "checked nothing" silenced this warning in the shape
every publishable package uses. Silence is still right when there is no project file at all —
then there is no place for the warning to be about.

**`rarn init` is the exception, and it has to be.** At install time an absent project file is
genuinely ambiguous: a library has no place, and warning it about one would be wrong. At
`init` the person is starting a project, and an empty directory is the case with the least to
go on — yet it was the only case that got no advice, because the same `scanned` check gated
both. Measured in the field: `rarn init` in an empty directory (silence), then `rarn add -D`,
which failed with `RN0031` because there was still no project file to derive `place` from.
The two commands ask different questions of the same scan, so they get different answers.

Two related rules:

- **A `shared` package may only depend on `shared` packages.** `server` and `dev` may depend on
  anything. Shared code replicates to clients, so a shared→server edge breaks at runtime.
- Placement resolves to the **widest** realm any requester asked for: `shared > server > dev`.
  A package must live where its most permissive requester can still reach it. This is why the
  lockfile records `placement` separately from the declared `realm`.

### 2a-2. The shim files are observable API, not an implementation detail

`sleitnick/knit` — one of the most used Roblox frameworks — does this:

```lua
--[=[ @prop Util Folder  @within KnitClient  @readonly ]=]
KnitClient.Util = (script.Parent :: Instance).Parent   -- the _Index entry folder
local Promise = require(KnitClient.Util.Promise)       -- via that variable
```

Two consequences, and both close doors:

- **Static rewriting of package sources is not viable.** The require does not name
  `script.Parent.Parent.Promise` anywhere; the folder is stashed in a variable first.
- **The folder is documented public API.** User code calls `Knit.Util.Signal`. Replacing
  the physical shim files with any kind of resolver would make that `nil`.

So the layout in constraint 2 is not free to optimize away later. Measured, not assumed:
see `docs/research/r1-pnp-feasibility.md`, which also records why a Yarn-PnP-style resolver was
investigated and rejected. Revisit only if Roblox ships `.luaurc` alias maps.

### 2a-3. A shim carries the module's value; its types have to be forwarded by hand

Luau passes a required module's **value** through a link and none of its **type aliases**.
So a one-line shim gives a `React` whose `createElement` type-checks and whose `React.Node` is
`Unknown type 'React.Node'` — at every call site, which makes a `--!strict` signature against
any typed package impossible to write. Measured: 300 of the 584 packages in a warm cache export
types from their entry module, 1943 aliases between them. Wally has the same hole.

The fix is one line per type, and it is the reason a shim is no longer always one line:

```lua
local Module = require(script.Parent._Index["jsdotlua_react@17.2.1"]["react"])

export type Node = Module.Node
export type PureComponent<Props, State = nil> = Module.PureComponent<Props, State>

return Module
```

Four things this rests on, all measured rather than assumed:

- **The forward works, generics included.** Verified with `luau-lsp analyze`: through the
  one-line form `L.Node` is `Unknown type`, through this form both `L.Node` and
  `L.Box<number>` resolve.
- **Only the entry module is read.** A type declared in a submodule reaches the outside only
  if the entry re-exports it, and then it is here under the name a user would write.
- **Silence is the failure mode.** Anything not understood is left out. A missed type costs
  the annotation someone was going to write by hand; a wrongly forwarded one puts an error in
  a generated file they did not write and cannot fix. That is why a declaration whose default
  names a type the module keeps private is dropped whole — it compiles in the package and not
  in the shim — and why the drop repeats to a fixed point, since dropping one can strand
  another.
- **A package that exports nothing keeps the one-line shim**, which is most of them.

The marker stays on the first line, so `linker/ownership.ts` and the Lune harness still
recognise an install. Both match on substring, and a shape check would have broken here.

**Where this shows up as a cost**: when a require cannot be resolved at all — analysing a realm
against a sourcemap that does not mount it — one diagnostic becomes one per forwarded type.
Nothing new is broken; the same require was already unresolvable.

### 2b. Install by rebuilding, then swapping

Rebuild the realm directories from the lockfile every time. No incremental updates, no
orphan tracking — a half-updated tree is far worse than a slightly slower install, and the
copy is cheap once the cache is warm. Scope deletion strictly to Rarn's own directories.

**Build into `.rarn-tmp/`, then rename into place.** Deleting the old tree first and writing
over the top is identical work right up until something interrupts it, and then the
difference is everything the user had: with staging they keep the previous install, without
it they keep neither. The previous tree moves to `.rarn-old-<token>/` and is deleted only
once every realm is in place.

**Never replace a directory Rarn did not create.** `linker/ownership.ts` runs before any
work and refuses unless the realm directory holds `_Index/`, holds only Rarn-generated
shims, or is empty. `assertSafePackageDir` constrains the *shape* of the path and nothing
more — it once claimed otherwise, and the gap between the claim and the code is what
withdrew 0.1.0: on a case-insensitive filesystem `packageDir: "Packages"` names a
`packages/` source tree, and the install replaced it. An existing Wally install passes the
check deliberately; replacing one is what migrating means.

Three properties that are easy to lose when touching `linker/swap.ts`:

- **One realm at a time, aside then in.** Moving all three aside first and then moving all
  three in leaves a moment where every realm is missing at once — the one state where an
  interrupted run looks like a deliberate uninstall.
- **A realm nothing was placed into is not rebuilt**, so retiring it is what makes removing
  the last server dependency actually reach the tree.
- **A failed rollback must say where the old tree is.** On Windows a file held open by
  Studio or a Rojo serve will refuse a rename, and the reverse rename can fail for the same
  reason. Reporting `RN0420` with the directory name is the difference between a bad moment
  and lost work.

It is **not** atomic across the three realms, and nothing can make it so. The claim is only
that the window is two renames on one filesystem with all the slow work already done.

`cache/store.ts` has a function that looks like this one and is deliberately not shared. There
an existing target means another process won a race, so the right move is to keep theirs and
drop ours; here the target is the user's previous install and it must lose.

Shims are written as `.luau`. (Wally writes `.lua`; both load fine.)

### 2c. Offline is a guarantee, not a coincidence

A fresh lockfile already makes an install do no network I/O — but *already does* and *cannot*
are different promises, and only the second one is worth anything on a train. `--offline`
(global) and `RARN_NO_NETWORK` are the same guard, reached two ways; both fail with `RN0130`
the moment anything reaches for the registry.

The guard wraps the global `fetch` rather than checking at each call site, so a request added
later is covered by default. It deliberately does **not** wrap an injected `fetch` — a
stand-in is not the network, and blocking it would turn the guard from a safety net into a
thing that fails the test suite.

There is no `--prefer-offline`. Yarn's version prefers cached *metadata*; Rarn caches
archives, not metadata, so the flag would describe behaviour that already happens and change
nothing. It comes back the day metadata is cached, and not before.

### 3. A Wally package zip is the whole source repo, not a module tree

Verified against `evaera/promise@4.0.0`: the zip holds **340 files** — `docs/`, `CHANGELOG.md`,
`selene.toml`, a vendored `modules/testez/` submodule — while the actual module is one file
at `lib/init.lua`.

The module root is declared by `default.project.json` (a Rojo project file) at the zip root:

```json
{ "name": "promise", "tree": { "$path": "lib" } }
```

Rarn **must** parse that file and copy only the resolved `$path`. Copying the zip root gives a
bloated install *and the wrong require depth*. Wally's `unpack_into_path` is a bare
`archive.extract(output)` — it copies everything and lets Rojo reinterpret the nested project
file at sync time, which is exactly why Wally installs need Rojo and Rarn's do not. Pruning at
install time is doing Rojo's job early.

Three things a 13-package survey turned up that the obvious implementation gets wrong:

- **Half the sample has no project file at all** (every `sleitnick/*` package). Those set
  `include` at publish time, so the zip root already *is* the module. Absent is the normal
  case, not an error — warn about it and half of all installs print a warning.
- **`$path` can name a file, not a directory** (`red-blox/signal` → `"Signal.luau"`).
- Savings range from 100% (promise, 340 → 2) to 15% (react, 20 → 17). Promise is the
  dramatic case, not the typical one.

Fallback when a project file is too complex to interpret: copy the whole tree and keep
going. Never fail the install over this.

### 3a. Package sources reach their dependencies by `:WaitForChild`, not by indexing

`require(script.Parent.Parent.Promise)` is the form the layout above implies, and it is not
the form most of the registry writes. The JS-port half — react-lua, jest-lua, luau-polyfill,
every `jsdotlua/*` package — writes `require(script.Parent.Parent:WaitForChild("promise"))`
and nothing else. Measured across the 584 packages in a warm cache: of 8317 requires that a
dot-and-bracket scanner could not read, **2772 were `:WaitForChild` and 280
`:FindFirstChild`**. On a real 52-package react install the ratio is not 37% but **1655 of
1663**.

Anything that reads package source has to treat the four spellings as one operation:
`.Name`, `["Name"]`, `:WaitForChild("Name")`, `:FindFirstChild("Name")`. Missing the last two
does not fail loudly — `doctor` counted them as unreadable, and then reported every
dependency they reached as declared-but-never-required, which is 310 lines of confident
wrongness on a correct install.

Two smaller traps in the same place. **An instance name may contain a dot**: Rojo strips one
extension, so `ReactFiberWorkLoop.new.lua` becomes an instance called
`ReactFiberWorkLoop.new`, and a scanner that reads the dot as punctuation erases the name.
And **only the first lookup past the parent chain is the dependency** — `script.Parent.Parent.Foo.Bar`
reaches `Foo`, and what follows is inside it.

### 4. Wally API facts (all verified live, 2026-08-20)

| Endpoint | Auth / headers | Returns |
|---|---|---|
| `GET /v1/package-metadata/{scope}/{name}` | none required | `{"versions":[...]}` |
| `GET /v1/package-contents/{scope}/{name}/{version}` | **`Wally-Version: 0.3.2` required** | ZIP bytes |
| `GET /v1/package-search?query=` | none required | search results |
| `POST /v1/publish` | GitHub token | — |

- Omitting `Wally-Version` on `package-contents` returns **426 Upgrade Required**. Metadata does
  not need it.
- `package-contents` advertises `Content-Type: application/gzip` but the body is a **ZIP**
  (magic bytes `PK 03 04`). Trust the magic bytes, never the header.
- The API base URL comes from `config.json` in the index repo: `https://api.wally.run/`.
- **Metadata alone carries the full dependency graph**, so resolution never needs to download a
  zip or clone the index. Download only after the version set is final.
- Version ranges use **Cargo syntax**, which differs from npm's in two ways and fails silently
  on both. `,` means AND where npm uses a space, and **a bare version is a caret requirement** —
  Cargo reads `4.0.0` as `^4.0.0` where npm reads it as an exact pin. Use `fromCargoRange`
  for anything coming from Wally and `normalizeRange` for anything written in `rarn.json`;
  they read the same text and are not interchangeable.

  The caret rule is not an edge case, it is how most `wally.toml` files are written. Verified
  by comparing published manifests against what the index stored: `sleitnick/comm@1.0.1`
  declares `evaera/promise@4` and the index holds `>=4.0.0, <5.0.0`; `red-blox/signal@2.0.2`
  declares `red-blox/spawn@1.0.0` and the index holds `>=1.0.0, <2.0.0`.

  The *index* itself only ever stores the expanded form — 76 of 76 requirements across 60
  packages and 231 versions were `>=X, <Y` — so the registry path never exercises the caret
  rule today. It goes through it anyway, because the alternative on the day that changes is
  Rarn quietly disagreeing with Wally about what a version means.
- Registry packages are immutable, so `{scope}_{name}@{version}` is a sufficient cache key.
- Each version declares `realm` (`shared` | `server`).
- Auth is a `Authorization: Bearer <token>` header and is optional; public packages need none.

The Wally client itself does **not** use the metadata endpoint — it git-clones the whole index
repository and reads files. Rarn's use of plain HTTP is what removes that clone, and with it
any dependency on git being installed.

**Every fan-out at this API needs a ceiling, and the curve is a cliff rather than a slope.**
Measured against the live registry, 150 packages, best of two runs:

```
 8 -> 5.0s    16 -> 2.8s    32 -> 1.8s    64 -> 7.4s    unbounded (150) -> 21.9s
```

Unbounded is twelve times slower than the best, which matters because resolution walks the
graph breadth-first: one round is every package at one depth, so a project with 506 direct
dependencies opened 506 sockets at the same instant and spent 44.8s where 8.9s was
available. Metadata runs 32 at a time and downloads 8 — different numbers because the
bodies are different sizes, and both chosen by measuring rather than by taste.

### 5. Dedupe policy: one version per major, resolved order-independently

Wally allows two versions of a package to coexist only when they are semver-*incompatible*
(different major; for `0.x`, different minor). That policy is right — compatible duplicates are
the singleton hazard from constraint 1 — and Rarn keeps it.

Wally's *algorithm*, however, is greedy BFS with no backtracking, so the outcome depends on
queue order. Given `^1.2.0` and `^1.5.0` with `1.9.0` published, if `1.2.0` activates first,
every `1.x` candidate is then rejected as "compatible with an already-selected version" and the
install dies on a conflict that has an obvious solution.

**Rarn must collect every constraint before choosing any version.** Walk the whole graph,
group ranges by package name, intersect, then pick — `^1.2.0 ∩ ^1.5.0` yields `1.9.0` for both.
Only report a conflict when the intersection is genuinely empty, and name the requesters and
ranges when you do.

## Architecture

Pipeline, in order. Each stage is a separate module with no knowledge of the next.

```
rarn.json -> resolve -> fetch -> extract -> prune -> link -> rarn.lock
             (semver)   (http)   (unzip)   (rojo)   (shims)
```

| Layer | Responsibility | Must not |
|---|---|---|
| `manifest` | read/write/validate `rarn.json` against its JSON Schema | touch the network |
| `registry` | Wally HTTP client; metadata, contents, search | know about the filesystem layout |
| `resolver` | semver range to exact version set, minimizing version count | perform I/O beyond `registry` |
| `cache` | global store: `downloads/` (zip) + `extracted/` (tree) | know about `RARN_MODULE` |
| `project` | Rojo `default.project.json` interpretation, module-root pruning | know about semver |
| `linker` | build `RARN_MODULE/`, `_Index/`, generate `.luau` shims | perform network I/O |
| `lockfile` | read/write/verify `rarn.lock` | resolve anything itself |
| `doctor` | scan installed Luau for requires, compare against declared deps; scan project files for trees sharing a DataModel | fetch or resolve anything |
| `publish` | archive building, `wally.toml` generation, GitHub device flow | know about `RARN_MODULE` layout |
| `import` | `wally.toml` text in, a `Manifest` out | touch the filesystem or the network |
| `project` (place) | read `default.project.json`, say where each realm lands in the DataModel | ever throw; an uninterpretable project file is a note |
| `install` | the pipeline: read, resolve or reuse, fetch, link, record | print anything, or default its registry to the network |
| `cli` | commander wiring, output, exit codes | contain business logic |

Business logic lives in the layers; `cli/` only wires and prints. Anything worth testing must
be reachable without spawning the CLI.

### Global cache

```
%LOCALAPPDATA%\rarn\cache\      (Windows)
~/.cache/rarn/                  (macOS, Linux)
  downloads/  evaera_promise@4.0.0.zip
  extracted/  evaera_promise@4.0.0/
```

Cached at the *extracted* level, so a warm reinstall does no network I/O and no unzip.
Copies into the project — **never hardlinks**: an edit in one project would propagate to every
other project sharing the cache. A `--linked` opt-in may come later.

### Naming

- Manifest keys are npm-shaped: `"@evaera/promise": "^4.0.0"`. Wally's own form is
  `evaera/promise`; the leading `@` is added on read and stripped on every API call.
- The Luau shim filename (the alias) is derived by PascalCasing the name part:
  `@evaera/promise` becomes `Promise.luau`. Collisions are a hard error, overridable via the
  manifest's `aliases` map.
- **An alias has to be unique within one manifest section, and nowhere wider.** Root shims
  are written per section — `dependencies` into the shared realm directory,
  `serverDependencies` into the server one, `devDependencies` into dev — so two aliases
  only ever land on the same path when they came from the same section.

  Pooling the three was stricter than the layout, and refused two arrangements it has no
  objection to: a shared `@evaera/promise` beside a server `@nezuo/promise` (different
  directories, and a person reaches them through different services), and the same package
  declared in two sections, which the linker explicitly supports and which the pooled check
  read as a collision of a package with itself. Both are measured — the second installs one
  copy in `_Index` and reaches it from the other realm by absolute path, so constraint 1
  still holds.

  The width matters more than it looks: of the 506 most-depended-upon packages, **40 aliases
  name more than one package** (`React` is published by `jsdotlua`, `haedrix` and
  `core-packages`). A real project meets this at twenty or thirty dependencies, not at five.
- **An alias may contain a hyphen.** Both schemas allowed only Luau identifiers, on the
  reasoning that `require(Packages.Alias)` should parse. The reasoning was fine and the rule
  was wrong: the entire `jsdotlua` family publishes `luau-polyfill`, `es7-types`,
  `instance-of`, `symbol-luau`, and their own source requires by those names, so a shim
  cannot be called anything else. `Packages["luau-polyfill"]` works.

  The lockfile schema carried the same pattern over `dependencies`, whose keys come from
  registry metadata rather than from anything Rarn chose — so `rarn install` of any react-lua
  package wrote a lockfile it then refused to read, and advised deleting the lockfile, which
  regenerated the same one. A schema constraining data the tool does not author has to
  describe what the registry actually contains.
- `_Index` folder names use Wally's own form, `{scope}_{name}@{version}`, so the layout stays
  legible to anyone who already knows Wally.

## Schemas

`schemas/rarn.schema.json` and `schemas/rarn.lock.schema.json` are the source of truth for both
file formats. Change the schema first, then the types, then the code — never the other way
round. Both are JSON Schema draft 2020-12.

`rarn.lock` is written with **sorted keys and a trailing newline** so diffs stay reviewable and
reruns are byte-identical. A resolution that is not reproducible is a bug.

**Two different things are both called `registry`.** At the top level of the lockfile it is the
**API base** the archives came from (`https://api.wally.run/`); in `root` and in the manifest it
is the **index repository** (`https://github.com/UpliftGames/wally-index`). Comparing across the
two makes every lockfile look permanently stale — which is exactly what happened once, so the
freshness check reads `root.registry` and nothing else.

### Reusing the lockfile

Resolution is the only stage that touches the network; fetching reads the global cache and
linking is local. So a fresh lockfile makes a repeat install fully offline — 670ms to 45ms on a
five-package graph.

Freshness is deliberately **asymmetric**. Declaring a usable lockfile stale costs a round trip.
Declaring a stale one usable installs versions the manifest no longer asks for *and reports
success*. Every comparison errs toward stale.

Only inputs to resolution are compared — dependencies, `resolutions`, and `root.registry`.
`packageDir`, `place` and `aliases` change where files land, and linking runs every install
regardless, so invalidating on them would force a full re-resolve over a renamed directory.
Ranges compare in `semver`'s canonical form, so `^1.0.0` rewritten as `1.x` is not a change,
while `>=1.0.0 <2.0.0` genuinely is (it admits `2.0.0-rc.1`; `^1.0.0` does not).

`moduleRoot` in the lockfile is **informational**. Installing re-derives it from the cached
archive rather than trusting the record — re-reading one small file is cheaper than the class of
bug where a stale lockfile silently changes what gets installed.

`--production` never writes the lockfile: its graph omits devDependencies and so no longer
describes the manifest.

## Publishing

Four facts the publish path is built around, all verified against the live API.

**The server reads `wally.toml` out of the uploaded zip.** It takes the package name
and version from there, not from anything sent alongside, so `rarn publish` generates
one from `rarn.json` and writes it into the archive last — a checked-in copy must
never shadow it, or a stale hand-written file decides what gets published.

**The generated ranges must be Cargo syntax.** `^1.2.0` and `>=1.0.0, <2.0.0` are
fine; `||` and hyphen ranges have no Cargo equivalent and are refused rather than
widened. Widening would publish a package whose declared dependencies are not the
ones its author tested.

**A published version is permanent.** There is no unpublish; the registry answers
`409` to a repeat. Two consequences: the upload is never retried (a retry after a
timeout is a second publish), and the default exclude list covers `.env`, `*.key`
and `*.pem`. The two ways of being wrong are not symmetric — one file too few breaks
an install and is fixed in minutes, one file too many cannot be undone at all.

**An installed dependency tree is excluded by shape, not by name.** Rarn derives its own
realm directories from `packageDir`, but it cannot derive what another tool called its:
Wally installs into `Packages/`, `ServerPackages/` and `DevPackages/`, and a migrated
project still has them. The first real package published came to 388 files before this,
339 of them a `DevPackages/` nobody meant to ship. So any directory holding an `_Index/`
is excluded along with the shims beside it. Matching the names would have been the
obvious fix and the wrong one — a project whose *source* lives in `Packages/` would then
publish nothing, and `include` cannot rescue a whole directory because only an
exactly-named path overrides a default exclusion.

**The first publish claims the scope.** A typo in the scope name takes that scope.

`include` overrides the built-in exclusions only when it names a path exactly.
A glob is a statement about a directory, not about a secret that happens to sit in it.

---

## Error codes

Every `RarnError` carries a stable `RN####` code from `src/util/codes.ts`, following
Yarn Berry's `YN0060` scheme. The code leads the rendered message so it is the first
thing a reader can copy into a search.

The point of a code is that it never changes. Wording gets rewritten; `RN0210` stays
`RN0210`. Two rules follow from that:

- **A shipped code is never reused for a different meaning.**
- **A retired code stays in the file** with a `Retired:` note instead of being deleted,
  so the number cannot be handed out twice.

Ranges are grouped by layer (`0001` CLI, `0010` manifest, `0100` registry, `0200`
resolution, `0300` cache, `0400` linking, `0500` lockfile) with gaps left inside each.
`tests/codes.test.ts` enforces uniqueness.

**A `how` may only point at something the reader has.** `RN0012` said *"The full schema is in
schemas/rarn.schema.json"* — a repository path, and every user of a released binary has a
binary. The advice has to survive leaving this checkout: a URL, a flag, a command, or the
answer itself. Preferably the answer: `RN0031` is the best-received message in the tool
because it prints the JSON to paste, and the person who met it stopped looking.

## Yarn conventions

Rarn is Yarn's model applied to Roblox, so where a decision has a Yarn precedent and no
platform reason to differ, follow Yarn:

- Command names and flags: `add -D`, `remove`, `install`, `up [--latest]`, `why`,
  `dedupe`, `list`. `--frozen-lockfile` keeps the Yarn Classic spelling.
- **`resolutions`** in the manifest forces a package to one exact version. This is more
  than a convenience here: it is the only escape hatch when two dependents demand
  incompatible majors, because the alternative is two ModuleScript copies and a broken
  singleton. Always report an override that was applied — a silent one is worse than the
  conflict it hides.

## Comments

Comment the **why**, never the **what**. If the signature already says it, delete it.

This codebase carries more prose than usual, and that is deliberate: the domain is full
of constraints nobody would guess from the code. `normalizeRange` is a one-line function
whose entire reason for existing — that skipping it misparses silently rather than
throwing — is invisible without a comment. Those earn their place. A comment restating a
parameter list does not.

No JSDoc type tags (`@param {string}`). Types live in the signature; a duplicated type
is one that eventually contradicts it.

## Where documents live

- `PLAN.md` — decisions, the milestones, and the gates. Deliberately thin: every
  completed milestone's full record (with its measurements) moves to `docs/milestones/`
  at completion and is **frozen** there — link fixes only, never content edits.
- `docs/milestones/<era>/` — records for the era being built now, currently `v1/` (the
  road to 1.0.0). **Milestone numbers restart at M1 each era**, so the same number exists
  in more than one place and the path is what distinguishes them. Unqualified `M1` means
  the current era; anything older is named with its path.
- `docs/archived/<version-range>/` — a closed era, whole. `v0.1.0-v0.1.1/` holds M0–M17,
  which is everything from an empty directory to the 0.1.1 release. Closed means closed:
  the folder's own README says what the era was for, and nothing inside it changes.
- `docs/research/` — investigations whose conclusion is fixed (R1 PnP, R2 workspaces,
  the Wally internals read-through). Never edited after their conclusion; research that
  supersedes one gets a new file, it does not rewrite the old one.
- `docs/known-issues.md` — the living record of **reproduced** defects, RN-numbered.
  When one is fixed, its detail collapses to a one-line stub under "해결됨" and the
  RN number is never reused — the same rule `codes.ts` applies to error codes.
  Fix details belong to CHANGELOG, not here.
- This file is the constraint authority and is loaded every session. Keep it deduplicated
  and do not split it: the constraints being in one place is what has kept them from
  drifting apart.

## Conventions

- Documentation language: what a user reads is **English** (README, CHANGELOG, release
  notes, CLI output); working documents are **Korean** (PLAN.md, docs/, commit messages).
  This file stays English.

  `README.ko.md` is the one exception, and it is a **translation, not a second document**:
  `README.md` is the source of truth and gets edited first, the Korean follows in the same
  commit, and the Korean file says so at the top. A translation that drifts is worse than
  none, because a reader has no way to tell which half is stale. Nothing else is
  translated — CHANGELOG and release notes stay English only.
- Commit messages in Korean, `type: subject` — matching the existing history.
- **Git flow. Four branch kinds and no others**, enforced by `.husky/branch-guard.sh`
  so that forgetting is not one of the outcomes:

  | | what it is | cut from | merges into |
  |---|---|---|---|
  | `master` | what has been released | — | `release/*`, `hotfix/*` |
  | `develop` | integration; every PR lands here | `master` | `master` via `release/*` |
  | `feat/*` | all ordinary work | `develop` | `develop` |
  | `release/*` | one version being finalised | `develop` | `master` **and** `develop` |
  | `hotfix/*` | a released version is hurting users | `master` | `master` **and** `develop` |

  **`feat/*` covers everything ordinary** — a fix, a refactor, a piece of research, a
  doc pass. Do not invent `fix/*` or `chore/*`: what changed is the commit message's
  job, and the only thing a prefix has to say is *where this work is going*.

  **`release/*` exists so that finalising a version does not stop development.** Cut
  `release/<version>` from `develop`, settle `package.json` and the CHANGELOG there,
  then merge it into `master` (tag) **and back into `develop`**. Skipping the
  back-merge is how the version bump goes missing from the next release.

  **`hotfix/*` is only for a version that is already out and already hurting.** Cut it
  from `master`, merge to both. Anything that merely feels urgent is still
  `feat/*` → `develop`. RN-1 qualified, and the choice made then — withdrawing the
  release rather than patching it — remains available and is often better.

  Merge into `develop` with `--no-ff`. **Never commit directly to `master`**; commits
  appear there only as merges from `release/*` or `hotfix/*`.

  Two things the guard cannot check, so they are on us: that a branch was cut from the
  right place, and that a stacked PR's parent merged first. **Both have gone wrong
  here** — a stacked PR merged out of order once and RN-3 did not reach `develop` until
  a recovery PR put it there.
- Biome formats and catches syntax; ESLint carries **only** type-aware rules that Biome
  structurally cannot express (`no-floating-promises` above all — an unawaited download
  leaves a half-written cache and no error). Do not duplicate a rule across both.
- `.husky/pre-commit` runs the full `check`, and CI runs the same command so a green
  hook and a green PR mean the same thing. If commits get slow enough to tempt
  `--no-verify`, move `typecheck`/`test` to `pre-push` rather than skipping the hook.
- A test must produce the same bytes twice. `zipSync` stamps the current time unless
  given an `mtime`, so any fixture archive fixes it — a digest comparison against a
  rebuilt archive otherwise fails only when the two calls straddle a timestamp tick,
  which is to say rarely, remotely, and never while you are looking.
- Every Wally API claim in this file was verified against the live service. If behavior looks
  different, re-verify with `curl` and **update this file in the same commit** as the fix.
