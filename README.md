<h1 align="center">Rarn</h1>

<p align="center">
  <b>R</b>oblox + Y<b>arn</b> — a package manager for Roblox that speaks the Wally registry.
</p>

<p align="center">
  <code>rarn.json</code> instead of <code>wally.toml</code> ·
  a real lockfile ·
  a global cache ·
  no Rojo required
</p>

<p align="center">
  <b>English</b> · <a href="README.ko.md">한국어</a>
</p>

---

Rarn installs the same packages Wally does, from the same registry, and lays them out
in the shape Luau's `require` actually needs. It just does the work Wally leaves to
Rojo — resolving the module root, pruning the archive, writing the link shims — at
install time instead of sync time.

```bash
rarn init
rarn add @sleitnick/knit
```

Already using Wally? Two lines:

```bash
rarn import          # wally.toml -> rarn.json
rarn install
```

```
installed 5 packages into RARN_MODULE
  26 files, 8 links, 338 pruned
  5 downloaded, 0 cached, resolved  2039ms
```

`338 pruned` is the point. Those five packages ship 364 files between them; 26 of them are
the modules, and the rest are docs, tests and CI config that Wally would copy into your
place and leave for Rojo to sort out at sync time.

> **Status: 0.2.0.** The install path is complete and verified — against a real Studio, a
> real `wally install`, and a require harness that models Roblox's instance-cached
> `require`. One package has been published to the live registry end to end and installed
> back from both Rarn and Wally. **The manifest and lockfile formats are not stable until
> 1.0**, which is what 1.0 will mean — a format freeze, not a feature list.
>
> [CHANGELOG.md](CHANGELOG.md) is what changed · [PLAN.md](PLAN.md) is where it is going ·
> [CLAUDE.md](CLAUDE.md) is every platform constraint the design is built around, with the
> measurements behind each one.

## Contents

| | |
|---|---|
| [Install](#install) | binary, Rokit, or from source |
| [Why not just Wally?](#why-not-just-wally) | what is actually different, and why |
| [Commands](#commands) | every command, grouped by what you are doing |
| [The manifest](#the-manifest) | `rarn.json`, field by field |
| [What the install looks like](#what-the-install-looks-like) | the tree, the shims, the realms |
| [Speed](#speed) | and [the 506-package comparison](#against-wally-on-506-real-packages) against Wally |
| [`rarn doctor`](#rarn-doctor) | what the installed source actually requires |
| [Publishing](#publishing) | and what is excluded by default |
| [Development](#development) | building, testing, the Roblox-side checks |

New here? [Why not just Wally?](#why-not-just-wally) is the two-minute version, and
[What the install looks like](#what-the-install-looks-like) is the one section worth reading
before you trust the tool with a project.

## Install

Rarn is a single self-contained binary with no runtime dependencies — no Bun, no Node, no
Rojo, no git.

```bash
rokit add Hawakiki/roblox-rarn rarn      # the second word is the alias, and it matters
rokit trust Hawakiki/roblox-rarn
rokit install
```

```toml
# rokit.toml, afterwards
[tools]
rarn = "Hawakiki/roblox-rarn@0.2.0"
```

**Give it the alias.** Rokit names a tool after its repository unless told otherwise, so
plain `rokit add Hawakiki/roblox-rarn` installs it as `roblox-rarn`, and `rarn` then fails
with *"Failed to find tool 'rarn' in any project manifest file"* — while a `rarn` shim sits
in `~/.rokit/bin` looking installed. The error reads as *add it*, so the obvious next move
is to add it again, which changes nothing. Editing the key in `rokit.toml` fixes it too.

The trust step is Rokit's, not Rarn's: it refuses to run a tool nobody has vouched for, and
without it `rokit install` stops with *"has not been marked as trusted"*. It is asked once
per machine.

Or take the archive for your platform from
[Releases](https://github.com/Hawakiki/roblox-rarn/releases) and put the binary on your PATH.
Windows x86-64, macOS arm64 and Linux x86-64 are built.

### From source

```bash
git clone https://github.com/Hawakiki/roblox-rarn
cd roblox-rarn
bun install
bun run build          # -> dist/rarn(.exe)
```

Cross-compiling works from any host, with one exception — see
[CLAUDE.md](CLAUDE.md#verifying-an-install) for why a Windows target must not be
cross-compiled with `--bytecode`:

```bash
bun build --compile --target=bun-windows-x64  src/cli.ts --outfile dist/rarn.exe
bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile dist/rarn
bun build --compile --target=bun-linux-x64    src/cli.ts --outfile dist/rarn
```

## Why not just Wally?

|  | Wally | Rarn |
|---|---|---|
| Registry | Wally | Wally — the same packages |
| Manifest | `wally.toml` | `rarn.json`, npm-shaped |
| Index access | clones the index repo (needs `git`) | plain HTTP |
| Package pruning | ships the whole source repo | ships only the module tree |
| Needs Rojo to install | yes | no |
| Resolution | greedy, order-dependent | collects every constraint, then intersects |
| Lockfile reuse | — | fully offline reinstall |
| Types through the link | lost — `Unknown type` at every call site | forwarded, so `--!strict` works |
| Duplicate visibility | none | `rarn why`, `rarn dedupe` |
| Unused / missing deps | none | `rarn doctor` |

Three of those are worth more than a table row.

**Resolution order matters.** Wally resolves greedily with no backtracking, so given
`^1.2.0` and `^1.5.0` with `1.9.0` published, whichever range is queued first can
activate `1.2.0` and cause every later `1.x` to be rejected as "already selected" — an
install that fails on a graph with an obvious solution. Rarn walks the whole graph
first, groups the ranges by package, and intersects them, so `^1.2.0 ∩ ^1.5.0` gives
`1.9.0` to both. A conflict is reported only when the intersection is genuinely empty,
and then it names the requesters and their ranges.

**A Wally archive is a source repo, not a module.** `evaera/promise@4.0.0` ships 340
files — `docs/`, a `CHANGELOG.md`, a vendored TestEZ — while the module itself is one
file at `lib/init.lua`. Wally extracts all of it and lets Rojo reinterpret the nested
project file at sync time. Rarn reads `default.project.json`, resolves its `$path`,
and copies only that. Which is why Rarn's output needs no Rojo to be correct.

What it does **not** do is second-guess what the author put *inside* that module root.
Some packages keep their own tests there — `jsdotlua/promise` ships an `init.spec.lua`
beside its source — and those arrive in your place along with everything else. Usually
that is a few kilobytes and no more; it stops being harmless if you run a test framework
whose default pattern is `**/?(*.)+(spec|test)`, because jest-lua will then discover the
package's specs as if they were yours. The fix belongs in your Rojo project, which is the
layer that decides what reaches the place:

```jsonc
"globIgnorePaths": ["**/*.spec.lua", "**/*.spec.luau", "**/__tests__/**"]
```

Rarn will not strip them itself. The module root is the author's declaration of what the
package is, and a package manager that quietly disagrees with it is a worse problem than
a stray spec file.

**A link loses the package's types, and that is fixable.** Luau carries a required
module's *value* through a link file and none of its type aliases, so through a Wally
link `React.createElement` type-checks while `React.Node` is `Unknown type 'React.Node'`
at every call site — which makes a `--!strict` signature against a typed package
impossible to write. 300 of the 584 most-depended-upon packages export types this way. Rarn
reads what the entry module declares and re-exports it, so the annotation you wanted to
write is the annotation you write. [What the install looks like](#what-the-install-looks-like)
has the generated file.

## Commands

Yarn's names, because Rarn is Yarn's model applied to Roblox.

### Everyday

| | |
|---|---|
| `rarn init` | create a `rarn.json` |
| `rarn import` | create one from an existing `wally.toml`. `--dry-run` |
| `rarn add <pkg…>` | add and install. `-D` dev, `--server` server, `-E` exact |
| `rarn install` | install what the manifest asks for. `--frozen-lockfile`, `--production` |
| `rarn remove <pkg…>` | drop from the manifest and reinstall |
| `rarn up [pkg…]` | raise the ranges in `rarn.json`. `--latest` ignores them entirely |

### Understanding a tree

| | |
|---|---|
| `rarn list` (`ls`) | the installed tree. `--depth <n>` |
| `rarn why <pkg>` | every path from `rarn.json` down to it |
| `rarn dedupe` | packages installed at more than one version, and who asked — including trees outside this project that share its DataModel |
| `rarn outdated` | installed vs newest-in-range vs newest. `--check` for CI |
| `rarn doctor` | requires in the installed source vs the declared dependencies |

`place` is read out of the project's Rojo files when `rarn.json` does not declare it —
any `*.project.json`, not one fixed name, because most multi-place repositories name the
file per place or nest one per place. Rarn says so when the two sources disagree, when two
project files put one realm in different places, or when a package directory has packages
in it that no Rojo project carries. Roblox reports a wrong path as `Requested module
experienced an error while loading`, with no path in it, so the check has to happen here.

### Registry

| | |
|---|---|
| `rarn search <query>` | search the registry |
| `rarn info <pkg>[@ver]` | versions, realm, license, dependencies |
| `rarn login` / `logout` / `whoami` | GitHub device flow; the token is per registry |
| `rarn pack` | build the archive `publish` would upload. `--list`, `-o <file>` |
| `rarn publish` | upload it. `--dry-run` |

### Everywhere

`--cwd <path>` · `--verbose` · `--silent` · `--no-color` · `--offline` · `--json` on most
read commands.

`--offline` refuses to touch the network rather than quietly reaching for it. With an
up-to-date `rarn.lock` and a warm cache an install needs none, so this costs nothing and
turns "it happened not to need the network" into "it cannot use it" — which is the version
worth having on a train. `RARN_NO_NETWORK=1` does the same thing for a whole shell or a CI
job.

Exit codes: `0` fine, `1` your project or arguments, `2` the registry or the network.
Errors carry a stable code — `RN0210` means the same thing forever, whatever the
wording around it becomes.

The number says which layer, which is usually enough to know whose problem it is:

| | |
|---|---|
| `RN00xx` | the CLI, or `rarn.json` |
| `RN01xx` | the registry or the network |
| `RN02xx` | resolution — conflicts, realms, cycles |
| `RN03xx` | the cache, downloads, archives |
| `RN04xx` | interpreting a project file, or writing the tree |
| `RN05xx` | `rarn.lock` |
| `RN06xx` | auth, packing, publishing |
| `RN07xx` | importing a `wally.toml` |

The full list is `src/util/codes.ts`. A shipped code is never reused for a different
meaning and a retired one is never deleted, so a search for a number always lands on one
thing.

## The manifest

```jsonc
{
  "name": "@you/your-game",
  "version": "0.1.0",
  "realm": "shared",

  "dependencies":       { "@sleitnick/knit": "^1.7.0" },
  "serverDependencies": { "@evaera/promise": "^4.0.0" },
  "devDependencies":    { "@roblox/testez":  "^0.4.1" },

  // Forces one version when two dependents demand incompatible majors. On Roblox
  // this is not a convenience — the alternative is two ModuleScript copies.
  "resolutions": { "@evaera/promise": "4.0.0" },

  // Only needed when a server or dev package depends on a shared one.
  "place": { "sharedPackages": "game.ReplicatedStorage.Packages" }
}
```

Ranges are npm syntax — `^1.2.3`, `~1.2.3`, `>=1.2.0 <2.0.0`, `1.2.x`, `*`, `||`.

Wally uses Cargo syntax, which differs twice over. `,` is its AND separator, and **a bare
version is a caret requirement** — Cargo reads `1.0.0` as `^1.0.0` where npm reads it as an
exact pin. Neither difference throws, so both are translated explicitly rather than hoped
about: `rarn import` turns `red-blox/spawn@1.0.0` into `^1.0.0`, which is what the registry
itself stored for that line. Going the other way, `rarn publish` refuses a range Cargo cannot
express instead of quietly widening it.

## What the install looks like

```
RARN_MODULE/                        <- shared
  Promise.luau                      <- shim; only direct dependencies appear here
  _Index/
    evaera_promise@4.0.0/
      promise/                      <- the real source, exactly one copy
        init.luau
    sleitnick_knit@1.7.0/
      knit/
      Promise.luau                  <- shim, sibling of the source folder
RARN_MODULE_SERVER/                 <- server realm, same shape
RARN_MODULE_DEV/                    <- dev realm, same shape
```

```lua
-- RARN_MODULE/Promise.luau
return require(script.Parent._Index["evaera_promise@4.0.0"]["promise"])
```

This shape is forced, not chosen. Package sources contain hardcoded
`require(script.Parent.Parent.Alias)` calls, so a dependency shim has to sit as a
*sibling* of the package's own source folder or the call resolves to `nil`.

**A shim forwards the package's types, so `--!strict` works.** Luau carries a required
module's *value* through a link and none of its type aliases, which is why
`React.createElement` type-checks through a Wally link while `React.Node` is
`Unknown type 'React.Node'` at every call site. Rarn reads what the entry module
exports and re-exports it:

```lua
-- Packages/React.luau
local Module = require(script.Parent._Index["jsdotlua_react@17.2.1"]["react"])

export type Node = Module.Node
export type PureComponent<Props, State = nil> = Module.PureComponent<Props, State>

return Module
```

300 of the 584 most-depended-upon packages export types this way. Anything Rarn cannot
read confidently is left out rather than guessed at — a missing alias costs you the
annotation you were going to write anyway, a wrong one puts an error in a generated
file you did not write. A package that exports no types keeps the one-line shim.

**Duplicates are a correctness bug here, not wasted disk.** Roblox's `require` takes an
Instance and caches per ModuleScript instance, so two copies of a package are two
modules with two separate sets of state — every singleton inside quietly becomes two.
Two packages that resolve to one version share one `_Index` folder, which is how the
dedupe is enforced structurally rather than by convention.

Realms are siblings, never nested, because each one is synced to a different Roblox
service. A shim can only walk relatively within one realm, so a server package that
depends on a shared one needs an absolute DataModel path — that is what `place` is for.
A `shared` package may only depend on `shared` packages: shared code replicates to
clients, so a shared→server edge breaks at runtime.

**The two sibling names come from `packageDir`**, by appending `_SERVER` and `_DEV`. Set
`packageDir` to `Packages` and the three directories are `Packages/`, `Packages_SERVER/`
and `Packages_DEV/`. They are not configurable separately, and `rarn install` prints the
ones it wrote.

Each needs a Rojo entry to reach Studio, and only two of them need a `place`:

| directory | mount it | `place` entry |
|---|---|---|
| `Packages/` | wherever shared code lives, usually `ReplicatedStorage` | `sharedPackages` |
| `Packages_SERVER/` | a server-only service, usually `ServerScriptService` | `serverPackages` |
| `Packages_DEV/` | anywhere, in whichever project file runs your tests | none — see below |

There is no `place.devPackages`, and there is no third directory missing from the table.
A package lands in the **widest** realm that asked for it, so anything requiring a
dev-placed package would have pulled it out of dev already — nothing ever has to reach
*into* dev by absolute path. The other two do, which is the whole reason `place` exists.

## Speed

Resolution is the only stage that touches the network. Fetching reads a global cache
and linking is entirely local, so a fresh lockfile makes a repeat install fully offline.

| | five-package graph |
|---|---|
| cold, nothing cached | ~2.0 s |
| warm cache, fresh lockfile | **~65 ms** |

The cold number is mostly network and will not be yours; the warm one is the claim
worth making, because it involves no requests at all.

The cache stores extracted trees, not just archives, so a warm install does no network
I/O and no unzip. It copies rather than hardlinks — an edit in one project must not
propagate to every other project sharing the cache.

### Against Wally, on 506 real packages

506 packages taken from the live registry by how often other packages depend on them,
575 once their transitive dependencies are counted. Windows 11, Bun 1.3.14, Wally 0.3.2.
The method, the other set sizes, and how the set was chosen are in
[test/benchmark](test/benchmark/README.md).

| | rarn | wally |
|---|---:|---:|
| install, warm cache | **5.6 s** — no network at all | 9.8 s — re-downloads all 575 |
| install, cold cache | 37.3 s | 9.8 s |
| first run on a machine | 37.3 s | 9.8 s **+ 12 s** index clone (46 MB, needs `git`) |
| files written | **7,045** | 12,956 |
| bytes written | **43.3 MB** | 107.9 MB |
| module roots that resolve without Rojo | **548 / 556 (98.6%)** | 148 / 575 (25.7%) |
| a package's types reachable through the link | **yes** | no — `Unknown type` at every call site |

Three things that table is not hiding:

- **Wally wins the cold install.** It clones the registry index, so resolving costs it no
  network; Rarn asks over HTTP and spends 8.9 s of those 37.3 s doing it. That is the
  price of not needing `git` and not keeping a 46 MB clone.
- **Wally has no package cache.** Only the index is cached, so every install downloads
  every archive again. That is why its column has one number and not two, and why CI is
  where the difference shows.
- **The last row is not about speed.** A Wally install leans on Rojo to reinterpret each
  package's nested project file at sync time, so three quarters of its module folders have
  no `init` at their root. Rarn does that work at install time instead. There were **no
  packages Wally could install and Rarn could not.**

Writing the benchmark turned up two shipped defects, neither visible on a small graph: an
archive holding a file over 512 KiB could not be unpacked at all, and resolution opened one
socket per package. Both are fixed — see the CHANGELOG.

Freshness is deliberately asymmetric. Calling a usable lockfile stale costs one round
trip; calling a stale one usable installs versions the manifest no longer asks for
**and reports success**. Every comparison errs toward stale.

## `rarn doctor`

Scans the installed Luau for requires that reach past the module root — the ones that
resolve through a shim — and compares them against what was declared.

```
@scope/example@1.0.0
  requires NotDeclared — not a declared dependency
    RARN_MODULE/_Index/scope_example@1.0.0/example/init.lua:13  resolves to nil at runtime

  scanned 20 files across 5 packages
  10 requires are built at runtime and could not be checked
```

A missing dependency exits `1`; an unused declaration only warns, since a generous
manifest breaks nothing. Requires that cannot be resolved statically are counted and
reported rather than hidden — a check that conceals how much it could not see reads as
more thorough than it is.

It reads the four spellings Roblox accepts for one lookup, because packages use all of
them and a scanner that knows only two is worse than none:

```lua
require(script.Parent.Parent.Promise)                -- indexing
require(script.Parent.Parent["Promise"])             -- bracketed
require(script.Parent.Parent:WaitForChild("promise")) -- the JS-port half of the registry
require(script.Parent.Parent:FindFirstChild("promise"))
```

That third form is not an edge case. Every `jsdotlua/*` package — react-lua, jest-lua,
luau-polyfill — writes it and nothing else, so on a 52-package React install 1655 of 1663
requires were unreadable before this, and each one came back out as a dependency wrongly
reported as never required. It is 10 now.

It also follows a require through a variable, because the most used framework in the
ecosystem needs it:

```lua
KnitClient.Util = (script.Parent :: Instance).Parent
local Promise = require(KnitClient.Util.Promise)   -- still found
```

## Publishing

```bash
rarn login              # GitHub device flow, read:user only
rarn pack --list        # see exactly what would be uploaded
rarn publish --dry-run  # everything except the upload
rarn publish
```

The registry reads `wally.toml` out of the uploaded archive to learn the package name
and version, so Rarn generates one from `rarn.json` and puts it in — a checked-in copy
never shadows it.

`.env`, `*.key`, `*.pem` and the realm directories are excluded by default, and so is
any directory holding an `_Index/` — that is another package manager's install tree,
recognised by shape because Rarn cannot know what someone else's directory was called.
A published version is permanent and public, with no unpublish, so shipping one file too
few breaks an install and gets fixed in minutes while shipping one too many cannot be
undone at all. Naming a file exactly in `include` overrides that; a glob does not.

## Development

```bash
bun test                 # the whole suite
bun run check            # format + lint + typecheck + test, in that order
bun run src/cli.ts <..>  # run the CLI without building
```

`bun run check` is what the pre-commit hook runs.

Roblox-side verification is separate, and comes from `rokit.toml`:

```bash
lune run tests/roblox/verify.luau -- <install-dir> [<realm>] [--mount=<path>=<dir>]... [--execute]
```

This reimplements Roblox's `require` — instance-based lookup, per-instance caching —
over a real install tree, and answers the two questions a file-tree assertion cannot:
does every shim reach a real ModuleScript, and does one package reached by two paths
come back as **one instance**. Two copies look identical on disk and only diverge at
runtime. `bun test` runs it on a synthetic tree with three deliberately broken trees
alongside, because a harness nothing can fail is worth nothing.

A shim that crosses realms names an absolute DataModel path, so the sibling realm has to be
mounted with `--mount` for there to be anything to resolve against. Without one the check
reports as *not verified* rather than failed — until 2026-08-22 it reported the correct shim
as broken instead.

The model has been checked against a real Studio once, on a `rojo build` of
`test/roblox/`: 17 checks, and Studio agreed on every one — including the two that
matter most, that two copies of one source are two tables and that one instance required
twice is one table. `tests/roblox/emulate-selftest.luau` asks the other question, which
is whether the model behaves the way it claims to; two defects had been living in that
gap.

It does not replace `test/roblox/`. The harness proves the tree is consistent under a
*model* of Roblox; if the model is wrong, it passes and Studio breaks. Package code is
not executed unless you pass `--execute`, and even then the engine is not there —
`Enum`, `Instance.new`, `task` and `RunService` are outside the model on purpose, because
every stub added widens the area in which a *passing* harness can be silently wrong.

## License

MIT
