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

---

Rarn installs the same packages Wally does, from the same registry, and lays them out
in the shape Luau's `require` actually needs. It just does the work Wally leaves to
Rojo — resolving the module root, pruning the archive, writing the link shims — at
install time instead of sync time.

```bash
rarn init
rarn add @sleitnick/knit
```

```
installed 5 packages into RARN_MODULE
  26 files, 6 links, 338 pruned
  5 downloaded, 0 cached, resolved  1139ms
```

> **Status: pre-alpha.** The install path is complete and tested; publishing works but
> has not been run against the live registry. See [PLAN.md](PLAN.md) for the roadmap
> and [CLAUDE.md](CLAUDE.md) for the architecture and the platform constraints behind it.

## Install

Rarn is a single self-contained binary with no runtime dependencies.

```bash
git clone https://github.com/Hawakiki/roblox-rarn
cd roblox-rarn
bun install
bun run build          # -> dist/rarn(.exe)
```

Cross-compiling works from any host:

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
| Duplicate visibility | none | `rarn why`, `rarn dedupe` |
| Unused / missing deps | none | `rarn doctor` |

Two of those are worth more than a table row.

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

## Commands

Yarn's names, because Rarn is Yarn's model applied to Roblox.

### Everyday

| | |
|---|---|
| `rarn init` | create a `rarn.json` |
| `rarn add <pkg…>` | add and install. `-D` dev, `--server` server, `-E` exact |
| `rarn install` | install what the manifest asks for. `--frozen-lockfile`, `--production` |
| `rarn remove <pkg…>` | drop from the manifest and reinstall |
| `rarn up [pkg…]` | raise the ranges in `rarn.json`. `--latest` ignores them entirely |

### Understanding a tree

| | |
|---|---|
| `rarn list` (`ls`) | the installed tree. `--depth <n>` |
| `rarn why <pkg>` | every path from `rarn.json` down to it |
| `rarn dedupe` | packages installed at more than one version, and who asked |
| `rarn outdated` | installed vs newest-in-range vs newest. `--check` for CI |
| `rarn doctor` | requires in the installed source vs the declared dependencies |

### Registry

| | |
|---|---|
| `rarn search <query>` | search the registry |
| `rarn info <pkg>[@ver]` | versions, realm, license, dependencies |
| `rarn login` / `logout` / `whoami` | GitHub device flow; the token is per registry |
| `rarn pack` | build the archive `publish` would upload. `--list`, `-o <file>` |
| `rarn publish` | upload it. `--dry-run` |

### Everywhere

`--cwd <path>` · `--verbose` · `--silent` · `--no-color` · `--json` on most read commands.

Exit codes: `0` fine, `1` your project or arguments, `2` the registry or the network.
Errors carry a stable code — `RN0210` means the same thing forever, whatever the
wording around it becomes.

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
Wally's own manifests use Cargo syntax, where `,` is the AND separator; Rarn translates
in both directions and refuses to publish a range Cargo cannot express rather than
quietly widening it.

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
return require(script.Parent._Index["evaera_promise@4.0.0"].promise)
```

This shape is forced, not chosen. Package sources contain hardcoded
`require(script.Parent.Parent.Alias)` calls, so a dependency shim has to sit as a
*sibling* of the package's own source folder or the call resolves to `nil`.

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

## Speed

Resolution is the only stage that touches the network. Fetching reads a global cache
and linking is entirely local, so a fresh lockfile makes a repeat install fully offline.

| | five-package graph |
|---|---|
| cold, nothing cached | ~1100 ms |
| warm cache, fresh lockfile | ~45 ms |

The cache stores extracted trees, not just archives, so a warm install does no network
I/O and no unzip. It copies rather than hardlinks — an edit in one project must not
propagate to every other project sharing the cache.

Freshness is deliberately asymmetric. Calling a usable lockfile stale costs one round
trip; calling a stale one usable installs versions the manifest no longer asks for
**and reports success**. Every comparison errs toward stale.

## `rarn doctor`

Scans the installed Luau for requires that reach past the module root — the ones that
resolve through a shim — and compares them against what was declared.

```
@sleitnick/knit@1.7.0
  requires NotDeclared — not a declared dependency
    RARN_MODULE/_Index/sleitnick_knit@1.7.0/knit/init.lua:13  resolves to nil at runtime
  scanned 16 files across 5 packages
  7 requires are built at runtime and could not be checked
```

A missing dependency exits `1`; an unused declaration only warns, since a generous
manifest breaks nothing. Requires that cannot be resolved statically are counted and
reported rather than hidden — a check that conceals how much it could not see reads as
more thorough than it is.

It follows a require through a variable, because the most used framework in the
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

`.env`, `*.key`, `*.pem` and the realm directories are excluded by default. A published
version is permanent and public, with no unpublish, so shipping one file too few breaks
an install and gets fixed in minutes while shipping one too many cannot be undone at
all. Naming a file exactly in `include` overrides that; a glob does not.

## Development

```bash
bun test                 # the whole suite
bun run check            # format + lint + typecheck + test, in that order
bun run src/cli.ts <..>  # run the CLI without building
```

`bun run check` is what the pre-commit hook runs.

Roblox-side verification is separate, and comes from `rokit.toml`:

```bash
lune run tests/roblox/verify.luau -- <install-dir> [<realm>] [--execute]
```

This reimplements Roblox's `require` — instance-based lookup, per-instance caching —
over a real install tree, and answers the two questions a file-tree assertion cannot:
does every shim reach a real ModuleScript, and does one package reached by two paths
come back as **one instance**. Two copies look identical on disk and only diverge at
runtime. `bun test` runs it on a synthetic tree with three deliberately broken trees
alongside, because a harness nothing can fail is worth nothing.

It does not replace `test/roblox/`. The harness proves the tree is consistent under a
*model* of Roblox; if the model is wrong, it passes and Studio breaks.

## License

MIT
