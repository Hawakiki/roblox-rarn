import semver from 'semver'
import { RarnError } from './errors.ts'
import { type PackageName, parseWallyName } from './package-name.ts'

/**
 * Range syntax translation between the Wally registry and npm's `semver`.
 *
 * This is the single highest-risk conversion in Rarn, because getting it wrong
 * fails silently rather than loudly.
 *
 * Wally inherits Cargo's syntax, where a comma means AND:
 *
 *     ">=4.0.0, <5.0.0"
 *
 * npm's `semver` uses a *space* for AND and treats a comma as junk. Feeding a
 * Cargo range to `semver` straight does not throw — it misparses, and the resolver
 * then picks a wrong version with total confidence. Every range arriving from the
 * registry must pass through `normalizeRange` first.
 */

/**
 * Converts a Cargo-style range to the equivalent npm range.
 *
 * Only the separator differs; `^`, `~`, `>=`, `<`, `=` and `*` mean the same thing
 * in both. Splitting on commas and rejoining with spaces is therefore the whole job,
 * plus whitespace tidying so that comparisons and cache keys stay stable.
 */
export function normalizeRange(range: string): string {
  const normalized = range
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    // `semver` accepts '>= 1.0.0', but leaving the gap in would let the same
    // constraint produce two different strings, and these strings end up in
    // lockfiles and cache keys where that difference would show as a false diff.
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .trim()

  if (normalized.length === 0) {
    throw new RarnError({
      what: `'${range}' is not a usable version range.`,
      where: range,
      how: "Use a range such as '^4.0.0', '>=1.0.0 <2.0.0', or '*'.",
    })
  }

  if (semver.validRange(normalized) === null) {
    throw new RarnError({
      what: `'${range}' is not a valid version range.`,
      where: range,
      how: "Use a range such as '^4.0.0', '>=1.0.0 <2.0.0', or '*'.",
    })
  }

  return normalized
}

/** A dependency request: a package plus the range that was asked for. */
export interface PackageReq {
  readonly name: PackageName
  /** Always npm syntax — normalized at construction, never Cargo. */
  readonly range: string
}

/**
 * Parses the registry's dependency value, `scope/name@range`.
 *
 * The range may itself contain '@'-free Cargo syntax with commas, so the split is
 * on the *first* '@' only: `"evaera/promise@>=4.0.0, <5.0.0"`.
 */
export function parsePackageReq(input: string): PackageReq {
  const at = input.indexOf('@')
  if (at === -1) {
    throw new RarnError({
      what: `Dependency '${input}' is missing a version range.`,
      where: input,
      how: "Registry dependencies look like 'evaera/promise@^4.0.0'.",
    })
  }

  return {
    name: parseWallyName(input.slice(0, at)),
    range: normalizeRange(input.slice(at + 1)),
  }
}

/**
 * Whether two versions are semver-compatible, and therefore must not both be installed.
 *
 * Mirrors Wally's rule so that Rarn's install tree stays interchangeable with Wally's:
 * a `0.x` release treats minor as its breaking axis, everything else uses major.
 *
 * This is a deliberate policy, not an optimization. Two compatible copies of a package
 * become two ModuleScript instances in Roblox, each with its own state, which quietly
 * breaks any singleton the package holds.
 */
export function areCompatible(a: string, b: string): boolean {
  const left = semver.parse(a)
  const right = semver.parse(b)
  if (left === null || right === null) {
    throw new RarnError({
      what: `Cannot compare versions '${a}' and '${b}'.`,
      how: 'Both must be exact semver versions.',
    })
  }

  if (left.compare(right) === 0) return true
  if (left.major === 0 && right.major === 0) return left.minor === right.minor
  return left.major === right.major
}

/**
 * The highest version satisfying every one of `ranges`, or null when they cannot
 * all hold at once.
 *
 * Collecting the full constraint set before choosing anything is what makes Rarn's
 * resolution order-independent. Wally picks greedily as it walks the graph and can
 * therefore fail on inputs that do have a solution: given `^1.2.0` and `^1.5.0` with
 * `1.9.0` published, activating `1.2.0` first makes every remaining `1.x` candidate
 * look like a conflict. Intersecting first yields `1.9.0` for both.
 */
export function bestVersionFor(
  versions: readonly string[],
  ranges: readonly string[],
): string | null {
  const satisfying = versions.filter((version) =>
    ranges.every((range) => semver.satisfies(version, range, { includePrerelease: false })),
  )
  if (satisfying.length === 0) return null
  return satisfying.reduce((best, version) => (semver.gt(version, best) ? version : best))
}
