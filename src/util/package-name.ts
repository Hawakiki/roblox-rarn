import lockSchema from '../../schemas/rarn.lock.schema.json' with { type: 'json' }
import { Code } from './codes.ts'
import { RarnError } from './errors.ts'

/**
 * A package identity, stored in the registry's own terms.
 *
 * Rarn writes `@scope/name` in manifests, the Wally registry uses `scope/name`,
 * and the install tree uses `scope_name@version`. Keeping the parts separate means
 * each form is produced on demand and none of them is ever parsed twice.
 */
export interface PackageName {
  readonly scope: string
  readonly name: string
}

/** Wally scopes and names: lowercase alphanumeric with inner dashes. */
const SEGMENT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function assertSegment(value: string, kind: 'scope' | 'name', source: string): void {
  if (SEGMENT.test(value)) return
  throw new RarnError({
    code: Code.InvalidPackageName,
    what: `'${value}' is not a valid package ${kind}.`,
    where: source,
    how: `A ${kind} must be lowercase letters, digits, or dashes, and may not start or end with a dash.`,
  })
}

/** Parses Rarn's manifest form, `@scope/name`. */
export function parsePackageName(input: string): PackageName {
  if (!input.startsWith('@')) {
    throw new RarnError({
      code: Code.InvalidPackageName,
      what: `Package name '${input}' is missing its leading '@'.`,
      where: input,
      how: `Rarn writes package names as '@scope/name'. Did you mean '@${input}'?`,
    })
  }
  return splitScopeAndName(input.slice(1), input)
}

/** Parses the registry's own form, `scope/name`. */
export function parseWallyName(input: string): PackageName {
  return splitScopeAndName(input, input)
}

function splitScopeAndName(body: string, source: string): PackageName {
  const slash = body.indexOf('/')
  if (slash === -1) {
    throw new RarnError({
      code: Code.InvalidPackageName,
      what: `Package name '${source}' is missing a scope.`,
      where: source,
      how: "Every Wally package is scoped, as in '@evaera/promise'.",
    })
  }
  const scope = body.slice(0, slash)
  const name = body.slice(slash + 1)
  assertSegment(scope, 'scope', source)
  assertSegment(name, 'name', source)
  return { scope, name }
}

/** `@evaera/promise` — the manifest and lockfile form. */
export function toRarnName(pkg: PackageName): string {
  return `@${pkg.scope}/${pkg.name}`
}

/** `evaera/promise` — the form every Wally API path expects. */
export function toWallyName(pkg: PackageName): string {
  return `${pkg.scope}/${pkg.name}`
}

/** `@evaera/promise@4.0.0` — the lockfile's `packages` key. */
export function toPackageKey(pkg: PackageName, version: string): string {
  return `${toRarnName(pkg)}@${version}`
}

/**
 * `evaera_promise@4.0.0` — the folder name under `_Index`, and the cache's key.
 *
 * Matches Wally's own layout so the tree stays legible to anyone who knows Wally.
 *
 * The one place a version becomes a path, so it refuses what is not one. Both ways a
 * version arrives check it first — the registry parser, and the lockfile schema for a
 * reused lockfile, which goes around the registry and semver both — and this is the
 * second gate for the same reason `shimPath` is one: whatever supplies a version next
 * will not have read either check.
 */
export function toIndexDir(pkg: PackageName, version: string): string {
  if (!isExactVersion(version)) {
    throw new RarnError({
      code: Code.InternalError,
      what: `${toWallyName(pkg)} arrived with the version ${JSON.stringify(version)}, which is not a plain folder name.`,
      where: toWallyName(pkg),
      how: 'Nothing was written under that name. It should have been refused when it was read, so this is a bug in Rarn: please report it.',
    })
  }
  return `${pkg.scope}_${pkg.name}@${version}`
}

/**
 * The default filename for a package's Luau shim, minus the extension.
 *
 * Derived by PascalCasing the name part, since Wally names are lowercase but Luau
 * code conventionally requires packages under a capitalized identifier:
 * `@evaera/promise` -> `Promise`, `@sleitnick/some-lib` -> `SomeLib`.
 *
 * A manifest `aliases` entry overrides this; two packages deriving the same alias
 * is a hard error the caller must report, since one shim would silently win.
 */
export function deriveAlias(pkg: PackageName): string {
  const alias = pkg.name
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')

  // A name may legally start with a digit, which cannot begin a Luau identifier.
  return /^[0-9]/.test(alias) ? `_${alias}` : alias
}

/**
 * Taken from the lockfile schema rather than restated, because every alias admitted
 * here is written into `rarn.lock` and that schema is what reads it back. A copy that
 * drifted wider would have `install` write a lockfile it then refuses to read, which
 * has happened here once already.
 */
const ALIAS = new RegExp(lockSchema.$defs.alias.pattern)

/**
 * Whether an alias can become a shim's file name and nothing more.
 *
 * The alias is joined onto a directory as `<alias>.luau`, so anything that is not a
 * single plain segment names some other file: `..` and a separator climb out of the
 * `_Index` entry, and `C:` and `a:b` both open an NTFS stream on a file beside the shim.
 * Letters, digits, `_` and `-` admit every one of the 45,794 aliases in the registry
 * (wally-index, 2026-09-25), hyphenated `jsdotlua` names included.
 */
export function isValidAlias(alias: string): boolean {
  return ALIAS.test(alias)
}

/** From the lockfile schema, for the same reason `ALIAS` is. */
const EXACT_VERSION = new RegExp(lockSchema.$defs.semver.pattern)

/**
 * Whether a version is exact semver 2.0.0 and therefore a single plain path segment.
 *
 * Not `semver.valid(v) === v`, which reads like the same rule and is not: `valid`
 * returns the version without its build metadata, so the comparison refuses the seven
 * registry versions that carry some (tazmondo/iris 2.5.2+89e7 among them, wally-index
 * 2026-09-25). And `semver` alone is too lenient to stand in for this — it trims
 * whitespace and takes a leading `v`, so `satisfies` happily selects `' 1.0.0'`.
 */
export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version)
}
