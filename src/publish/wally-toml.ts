import semver from 'semver'
import type { DependencyMap, NormalizedManifest } from '../manifest/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { parsePackageName, toWallyName } from '../util/package-name.ts'

/**
 * Renders the `wally.toml` that goes inside the published archive.
 *
 * This file is not a convenience for Wally users — the registry *requires* it. The
 * publish handler opens the uploaded zip, reads `wally.toml` out of it, and takes
 * the package name and version from there. Whatever `rarn.json` says is invisible
 * to the server, so an archive without this file is rejected before anything else
 * is looked at.
 */
export function renderWallyToml(manifest: NormalizedManifest): string {
  const name = toWallyName(parsePackageName(manifest.name))
  const lines: string[] = ['[package]', `name = "${name}"`, `version = "${manifest.version}"`]

  if (manifest.description !== undefined) lines.push(`description = ${quote(manifest.description)}`)
  if (manifest.license !== undefined) lines.push(`license = ${quote(manifest.license)}`)
  if (manifest.homepage !== undefined) lines.push(`homepage = ${quote(manifest.homepage)}`)
  if (manifest.repository !== undefined) lines.push(`repository = ${quote(manifest.repository)}`)
  if (manifest.authors !== undefined && manifest.authors.length > 0) {
    lines.push(`authors = [${manifest.authors.map(quote).join(', ')}]`)
  }

  lines.push(`realm = "${manifest.realm}"`, `registry = ${quote(manifest.registry)}`)

  // `exclude` is not carried over. Rarn decides the file list itself and ships
  // exactly that, so repeating the rule in a file the server also reads would let
  // the two disagree about what is in the archive that already exists.
  lines.push('', ...section('dependencies', manifest.dependencies))
  lines.push(...section('server-dependencies', manifest.serverDependencies))
  lines.push(...section('dev-dependencies', manifest.devDependencies))

  return `${lines.join('\n').trimEnd()}\n`
}

function section(header: string, deps: DependencyMap): string[] {
  const entries = Object.entries(deps)
  if (entries.length === 0) return []

  const lines = [`[${header}]`]
  for (const [name, range] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const wally = toWallyName(parsePackageName(name))
    lines.push(`${aliasFor(name)} = "${wally}@${toCargoRange(range, name)}"`)
  }
  return [...lines, '']
}

/**
 * The key a dependency gets in `wally.toml`.
 *
 * Wally's keys are the aliases that the package's own Luau source requires by, which
 * is the same thing Rarn derives its shim filenames from — so reusing that rule keeps
 * the published manifest describing the tree Rarn actually builds.
 */
function aliasFor(name: string): string {
  const { name: bare } = parsePackageName(name)
  return bare
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * npm range syntax to Cargo's.
 *
 * The two agree on `^`, `~`, `*`, and bare comparators, and differ on how a
 * conjunction is spelled: npm separates with a space, Cargo with a comma. Getting
 * that backwards does not throw — Cargo reads `>=1.0.0 <2.0.0` as one malformed
 * comparator — so the translation has to be explicit.
 *
 * Two npm forms have no Cargo equivalent at all and are refused rather than
 * approximated: `||` (there is no OR in a Cargo requirement) and the hyphen range
 * `1.0.0 - 2.0.0`. Silently widening either one would publish a package whose
 * declared dependencies are not the ones its author tested.
 */
export function toCargoRange(range: string, dependency: string): string {
  const trimmed = range.trim()

  if (trimmed.includes('||')) {
    throw unpublishable(dependency, trimmed, 'Cargo requirements have no OR (`||`).')
  }
  if (/\s-\s/.test(trimmed)) {
    throw unpublishable(dependency, trimmed, 'Cargo has no hyphen range (`1.0.0 - 2.0.0`).')
  }
  if (semver.validRange(trimmed) === null) {
    throw unpublishable(dependency, trimmed, 'It is not a valid semver range.')
  }

  // Space-separated comparators are an AND in npm and must become commas. Any
  // internal space inside one comparator (`>= 1.0.0`) is closed up first, or it
  // would be mistaken for the separator.
  return trimmed
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(', ')
}

function unpublishable(dependency: string, range: string, why: string): RarnError {
  return new RarnError({
    code: Code.UnpublishableRange,
    what: `${dependency} uses a range that cannot be published: ${range}`,
    where: 'rarn.json',
    detail: `  ${why}`,
    how: 'Rewrite it as a caret, tilde, or comparator range — for example `^1.2.0` or `>=1.2.0 <2.0.0`.',
  })
}

/** TOML basic string. Only the escapes TOML actually requires. */
function quote(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r')
  return `"${escaped}"`
}
