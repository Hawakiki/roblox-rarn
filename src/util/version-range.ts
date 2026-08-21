import semver from 'semver'
import { Code } from './codes.ts'
import { RarnError } from './errors.ts'
import { type PackageName, parseWallyName } from './package-name.ts'

/**
 * Range syntax translation between the Wally registry and npm's `semver`.
 *
 * This is the single highest-risk conversion in Rarn, because getting it wrong
 * fails silently rather than loudly.
 *
 * Wally inherits Cargo's syntax, which differs from npm's in two ways: a comma means
 * AND where npm uses a space, and a bare version means a caret where npm means an
 * exact pin. Neither difference throws. `semver` reads a Cargo comma as junk and a
 * bare Cargo version as a pin, and the resolver then proceeds with total confidence.
 *
 * So which direction a range came from decides which function it goes through, and
 * nothing may guess:
 *
 * | source | function |
 * |---|---|
 * | `rarn.json`, a typed argument | `normalizeRange` |
 * | the registry, a `wally.toml` | `fromCargoRange` |
 * | on the way *out*, to a published `wally.toml` | `publish/wally-toml.ts` |
 */

/**
 * Tidies a range that is **already npm syntax** — from `rarn.json` or from an
 * argument the user typed.
 *
 * Commas are accepted and read as AND, which npm does not require but which someone
 * arriving from `wally.toml` will type at least once. What this does *not* do is
 * apply Cargo's bare-version rule: in `rarn.json`, `"1.2.3"` means exactly `1.2.3`,
 * because that is what it means everywhere else npm syntax is written.
 *
 * Anything arriving from Wally — the registry, a `wally.toml` — goes through
 * `fromCargoRange` instead. The two are not interchangeable; see there.
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
      code: Code.InvalidVersionRange,
      what: `'${range}' is not a usable version range.`,
      where: range,
      how: "Use a range such as '^4.0.0', '>=1.0.0 <2.0.0', or '*'.",
    })
  }

  if (semver.validRange(normalized) === null) {
    throw new RarnError({
      code: Code.InvalidVersionRange,
      what: `'${range}' is not a valid version range.`,
      where: range,
      how: "Use a range such as '^4.0.0', '>=1.0.0 <2.0.0', or '*'.",
    })
  }

  return normalized
}

/**
 * Converts a Cargo requirement to the equivalent npm range.
 *
 * Two things differ, and the second one is the dangerous one.
 *
 * **The separator.** Cargo ANDs with a comma, npm with a space. Feeding a comma to
 * `semver` does not throw; it misparses.
 *
 * **A bare version is a caret requirement.** Cargo reads `1.2.3` as `^1.2.3`; npm
 * reads it as exactly `1.2.3`. This is not a subtlety at the edge of the syntax —
 * it is how most Wally manifests are written. Checked against the live registry:
 * `sleitnick/comm@1.0.1` declares `evaera/promise@4` and the index stored
 * `>=4.0.0, <5.0.0`; `red-blox/signal@2.0.2` declares `red-blox/spawn@1.0.0` and the
 * index stored `>=1.0.0, <2.0.0`. Reading those as exact versions would pin what the
 * author left open, and nothing would say so — the install succeeds, the tree is
 * correct, and the project simply never updates again.
 *
 * Everything Cargo can express, npm can. There is no `||` and no hyphen range in
 * Cargo, so this direction never has to give up on a requirement; the reverse
 * (`publish/wally-toml.ts`) does, and refuses rather than widening.
 *
 * A survey of 60 packages / 231 versions found that the *index* stores every
 * requirement pre-expanded as `>=X, <Y` — 76 of 76 — so the registry path never
 * exercises the caret rule today. It goes through here anyway: the day that changes,
 * the alternative is Rarn quietly disagreeing with Wally about what a version means.
 */
export function fromCargoRange(range: string): string {
  const parts = range
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(caretIfBare)

  const normalized = parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    .trim()

  if (normalized.length === 0 || semver.validRange(normalized) === null) {
    throw new RarnError({
      code: Code.InvalidVersionRange,
      what: `'${range}' is not a usable Cargo version requirement.`,
      where: range,
      how: "Wally requirements look like '^1.2.0', '1.2.0', or '>=1.2.0, <2.0.0'.",
    })
  }

  return normalized
}

/**
 * A leading `v` is not Cargo syntax at all, but a file containing one is broken
 * either way — and reading it as a caret is closer to any plausible intent than
 * reading it as an exact pin.
 */
function caretIfBare(part: string): string {
  if (!/^v?\d/.test(part)) return part
  // `1.*` and `1.2.*` already mean the same thing in both, and prefixing a caret
  // onto a wildcard is not valid in either.
  if (part.includes('*')) return part
  return `^${part}`
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
      code: Code.InvalidDependencySpec,
      what: `Dependency '${input}' is missing a version range.`,
      where: input,
      how: "Registry dependencies look like 'evaera/promise@^4.0.0'.",
    })
  }

  return {
    name: parseWallyName(input.slice(0, at)),
    range: fromCargoRange(input.slice(at + 1)),
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
      code: Code.InvalidVersion,
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
