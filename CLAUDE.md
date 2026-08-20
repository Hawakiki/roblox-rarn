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
bun run lint                         # biome check
bun run build                        # bun build --compile -> dist/rarn(.exe)
```

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
RARN_MODULE/
  Promise.luau                     <- shim; only direct deps appear at top level
  _Index/
    evaera_promise@4.0.0/
      promise/                     <- real source, exactly one copy
        init.luau
    sleitnick_knit@1.7.0/
      knit/
      Promise.luau                 <- shim; sibling of the source folder
```

```lua
-- RARN_MODULE/Promise.luau
return require(script.Parent._Index["evaera_promise@4.0.0"].promise)

-- RARN_MODULE/_Index/sleitnick_knit@1.7.0/Promise.luau
return require(script.Parent.Parent["evaera_promise@4.0.0"].promise)
```

The folder names `RARN_MODULE` and `_Index` are ours to rename. **The shape is not.**
A dep link must always sit as a *sibling* of the package's own source folder.

Two packages resolving to one version share one `_Index` folder, so their shims resolve to
the same ModuleScript instance — that is how dedupe is enforced structurally rather than by
convention.

### 3. A Wally package zip is the whole source repo, not a module tree

Verified against `evaera/promise@4.0.0`: the zip holds **340 files** — `docs/`, `CHANGELOG.md`,
`selene.toml`, a vendored `modules/testez/` submodule — while the actual module is one file
at `lib/init.lua`.

The module root is declared by `default.project.json` (a Rojo project file) at the zip root:

```json
{ "name": "promise", "tree": { "$path": "lib" } }
```

Rarn **must** parse that file and copy only the resolved `$path`. Copying the zip root gives a
bloated install *and the wrong require depth*. Wally itself copies everything and lets Rojo
sort it out at sync time — which is why Wally installs do not work without Rojo and Rarn's do.

Fallback when a project file is absent or too complex to interpret: copy the whole tree,
emit a warning, and keep going. Never fail the install over this.

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
- Each version declares `realm` (`shared` | `server`), which decides placement.

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

## Conventions

- Commit messages in Korean, `type: subject` — matching the existing history.
- Git flow, local only: `master` (releases), `develop` (integration), `feat/*` (work).
  Merge into `develop` with `--no-ff`. Never commit directly to `master`.
- Every Wally API claim in this file was verified against the live service. If behavior looks
  different, re-verify with `curl` and **update this file in the same commit** as the fix.
