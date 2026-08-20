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
    what: `'${value}' is not a valid package ${kind}.`,
    where: source,
    how: `A ${kind} must be lowercase letters, digits, or dashes, and may not start or end with a dash.`,
  })
}

/** Parses Rarn's manifest form, `@scope/name`. */
export function parsePackageName(input: string): PackageName {
  if (!input.startsWith('@')) {
    throw new RarnError({
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
 * `evaera_promise@4.0.0` — the folder name under `_Index`.
 *
 * Matches Wally's own layout so the tree stays legible to anyone who knows Wally.
 */
export function toIndexDir(pkg: PackageName, version: string): string {
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
