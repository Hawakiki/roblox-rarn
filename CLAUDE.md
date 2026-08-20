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
```

`bun run check` is what the pre-commit hook runs. Run it before committing rather
than discovering it at commit time.

`bun build --compile --target=bun-windows-x64|bun-darwin-arm64|bun-linux-x64` cross-compiles
from any host. `bun-windows-arm64` is not supported by Bun. Native `.node` addons do not
cross-compile, so **keep every dependency pure JS**.

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
return require(script.Parent._Index["evaera_promise@4.0.0"].promise)

-- RARN_MODULE/_Index/sleitnick_knit@1.7.0/Promise.luau
return require(script.Parent.Parent["evaera_promise@4.0.0"].promise)
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
return require(game.ReplicatedStorage.Packages._Index["evaera_promise@4.0.0"].promise)
```

If a cross-realm link is needed and `place` does not declare that path, fail with an
explanation of what to add — there is no way to synthesize it.

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
see `docs/pnp-feasibility.md`, which also records why a Yarn-PnP-style resolver was
investigated and rejected. Revisit only if Roblox ships `.luaurc` alias maps.

### 2b. Install by deleting and rebuilding

Wipe the realm directories and rebuild them from the lockfile. No incremental updates, no
orphan tracking — a half-updated tree is far worse than a slightly slower install, and the
copy is cheap once the cache is warm. Scope deletion strictly to Rarn's own directories.

Shims are written as `.luau`. (Wally writes `.lua`; both load fine.)

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
- Version ranges use **Cargo syntax, where `,` means AND**: `"evaera/promise@>=4.0.0, <5.0.0"`.
  npm's `semver` package uses a *space* for AND. Translating `, ` to ` ` before handing a range
  to `semver` is required — skipping it silently misparses every multi-comparator range.
- Registry packages are immutable, so `{scope}_{name}@{version}` is a sufficient cache key.
- Each version declares `realm` (`shared` | `server`).
- Auth is a `Authorization: Bearer <token>` header and is optional; public packages need none.

The Wally client itself does **not** use the metadata endpoint — it git-clones the whole index
repository and reads files. Rarn's use of plain HTTP is what removes that clone, and with it
any dependency on git being installed.

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
- `_Index` folder names use Wally's own form, `{scope}_{name}@{version}`, so the layout stays
  legible to anyone who already knows Wally.

## Schemas

`schemas/rarn.schema.json` and `schemas/rarn.lock.schema.json` are the source of truth for both
file formats. Change the schema first, then the types, then the code — never the other way
round. Both are JSON Schema draft 2020-12.

`rarn.lock` is written with **sorted keys and a trailing newline** so diffs stay reviewable and
reruns are byte-identical. A resolution that is not reproducible is a bug.

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

## Conventions

- Commit messages in Korean, `type: subject` — matching the existing history.
- Git flow, local only: `master` (releases), `develop` (integration), `feat/*` (work).
  Merge into `develop` with `--no-ff`. Never commit directly to `master`.
- Biome formats and catches syntax; ESLint carries **only** type-aware rules that Biome
  structurally cannot express (`no-floating-promises` above all — an unawaited download
  leaves a half-written cache and no error). Do not duplicate a rule across both.
- `.husky/pre-commit` runs the full `check`. If commits get slow enough to tempt
  `--no-verify`, move `typecheck`/`test` to `pre-push` rather than skipping the hook.
- Every Wally API claim in this file was verified against the live service. If behavior looks
  different, re-verify with `curl` and **update this file in the same commit** as the fix.
