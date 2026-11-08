import semver from 'semver'
import type { DependencyMap, NormalizedManifest } from '../manifest/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { byCodeUnit } from '../util/order.ts'
import { parsePackageName, toWallyName } from '../util/package-name.ts'
import { fromCargoRange } from '../util/version-range.ts'

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
  for (const [name, range] of entries.sort(([a], [b]) => byCodeUnit(a, b))) {
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
 * The two agree on every comparator that carries an operator, and differ in two
 * places that neither of them reports:
 *
 * - **The separator.** npm ANDs with a space, Cargo with a comma. Cargo reads
 *   `>=1.0.0 <2.0.0` as one malformed comparator.
 * - **A bare version.** npm reads `1.2.3` as exactly `1.2.3` and `1.2` as `<1.3.0`;
 *   Cargo reads both as carets, `<2.0.0`. Copied across unchanged, a pin becomes a
 *   major's worth of versions nobody tested, in a published version that can never
 *   be withdrawn. So no comparator leaves here bare: `1.2.3` becomes `=1.2.3`, `1.2`
 *   becomes `~1.2`, and `1` becomes `^1`, each of which means the same thing in both.
 *
 * Two npm forms have no Cargo equivalent at all and are refused rather than
 * approximated: `||` (there is no OR in a Cargo requirement) and the hyphen range
 * `1.0.0 - 2.0.0`. Silently widening either one would publish a package whose
 * declared dependencies are not the ones its author tested.
 *
 * The result is read back the way Rarn reads a published requirement and compared
 * with the original, and anything that does not come back meaning the same is
 * refused too. A form nobody thought of here should cost a publish, not a widened
 * range in the registry.
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

  // Any internal space inside one comparator (`>= 1.0.0`) is closed up first, or it
  // would be mistaken for the separator.
  const comparators = trimmed
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => cargoComparator(part, dependency, trimmed))
    .filter((part) => part !== ANY)

  // Cargo allows `*` only as the whole requirement, so it is dropped from a
  // conjunction — where it constrained nothing anyway — and kept only when it is all
  // there is.
  const cargo = comparators.length === 0 ? '*' : comparators.join(', ')

  const readBack = fromCargoRange(cargo)
  if (!semver.subset(readBack, trimmed) || !semver.subset(trimmed, readBack)) {
    throw unpublishable(
      dependency,
      trimmed,
      `Written for Cargo it would read as \`${cargo}\`, which is not the same range.`,
    )
  }
  return cargo
}

const ANY = '*'

/**
 * One npm comparator, spelled so Cargo reads what npm reads.
 *
 * npm treats `x`, `X` and `*` as "any" wherever they appear, and treats a missing
 * part the same way, so `^1.x` is `^1` and `1.2.x` is `1.2`. Dropping them first
 * leaves only plain partial versions, whose meaning Cargo documents for every
 * operator. A leading `v`, or a `=` after another operator, is npm leniency Cargo
 * does not share, and build metadata never affects which versions match.
 */
function cargoComparator(comparator: string, dependency: string, range: string): string {
  const match = /^(<=|>=|<|>|=|\^|~)?[v=]*([^-+]*)(-[^+]*)?(\+.*)?$/.exec(comparator)
  const op = match?.[1] ?? ''
  const core = (match?.[2] ?? '').split('.')

  const wildcard = core.findIndex((part) => part === '*' || part === 'x' || part === 'X')
  const numbers = wildcard === -1 ? core : core.slice(0, wildcard)
  if (match === null || numbers.some((part) => !/^\d+$/.test(part))) {
    throw unpublishable(
      dependency,
      range,
      `\`${comparator}\` is not a comparator Rarn can translate.`,
    )
  }

  if (numbers.length === 0) {
    if (op === '<' || op === '>') {
      throw unpublishable(dependency, range, `\`${comparator}\` matches no version at all.`)
    }
    return ANY
  }

  // npm ignores a prerelease written after a wildcard (`1.2.x-rc` is `1.2.x`).
  const version = numbers.join('.') + (wildcard === -1 ? (match[3] ?? '') : '')
  if (numbers.length === 3) return `${op === '' ? '=' : op}${version}`
  if (op !== '' && op !== '=') return `${op}${version}`
  // A partial exact match (`1.2`, `=1.2`) is a range in npm. Cargo's tilde and caret
  // say the same range in the spelling every Cargo reader agrees on.
  return numbers.length === 2 ? `~${version}` : `^${version}`
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
