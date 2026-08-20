# Rarn

**R**oblox + Y**arn** — a package manager for Roblox that speaks the Wally registry.

Rarn installs Wally packages with a `package.json`-shaped manifest, a real lockfile,
a global cache, and deduplication that Luau's instance-based `require` actually needs.

> Status: pre-alpha. See [PLAN.md](PLAN.md) for the roadmap and [CLAUDE.md](CLAUDE.md)
> for architecture and hard constraints.

## Why not just Wally?

| | Wally | Rarn |
|---|---|---|
| Registry | Wally | Wally (same packages) |
| Manifest | `wally.toml` | `rarn.json` |
| Global cache | per-project download | shared cache, zero-network reinstall |
| Package pruning | ships the whole source repo | ships only the module tree |
| Dedupe visibility | none | `rarn why`, `rarn dedupe` |
| Works without Rojo | no | yes |

## License

MIT
