# Changelog

Notable changes per release. Dates are release dates.

Rarn follows semver, with one clarification that matters before 1.0: **the manifest and
lockfile formats are not stable yet.** `lockfileVersion` exists so a change can be detected
rather than silently misread, and a `0.x` release may bump it.

## 0.1.0 — 2026-08-21

First release. The install path is complete and verified; publishing works but has never been
run against the live registry.

### Install

```toml
# rokit.toml
[tools]
rarn = "Hawakiki/roblox-rarn@0.1.0"
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
