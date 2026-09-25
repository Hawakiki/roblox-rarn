import semver from 'semver'
import { normalizeRange } from '../util/version-range.ts'
import { rangeMentionsPrerelease, selectVersions } from './select.ts'
import type { Constraint } from './types.ts'

/**
 * What `rarn up` does to one declared range.
 *
 * `unchanged` covers "already names the newest version it allows", "nothing published
 * fits", and ranges on one package that no release satisfies together, since none of
 * them leaves anything to write. `kept` is different: a newer version is allowed, and
 * no rewrite found here says so exactly. It is a safety net rather than an expected
 * outcome — every range it has been tried against has an exact rewrite — and it exists
 * because the alternative is writing one that is not.
 */
export type RangeUpgrade =
  | { readonly kind: 'raised'; readonly range: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'kept'; readonly newest: string }

const UNCHANGED: RangeUpgrade = { kind: 'unchanged' }

/**
 * The range `rarn up` writes back for `declared`, given every published version.
 *
 * **Without `--latest`, only the floor moves.** Moving it is the point: it records that
 * the project has moved on, and the changed range is what makes the lockfile stale, so
 * the reinstall resolves again instead of reusing the old answer.
 *
 * The result admits exactly what the declared range admitted from its newest allowed
 * version upward. Never more: the reinstall resolves the rewritten range, not the one
 * the person wrote, so writing `~1.2.0` back as `^1.2.5` installs `1.3.0`, and
 * `>=1.0.0 <1.5.0` as `^1.4.2` installs `1.5.0` — past the bound, reporting success.
 * Never less either, because a ceiling lowered without being asked is the same silent
 * edit pointed the other way, and it surfaces only when a later `up` refuses to move.
 * The one known exception is an exact prerelease ANDed with another bound, as in
 * `>=1.3.1 =2.2.2-beta.1`: `semver.subset` reads that pair as admitting nothing, so a
 * rewrite can drop the prerelease. No manifest has been seen to write one.
 *
 * The floor is raised in the notation the person used, where that notation has one:
 * `^` stays `^`, `~` stays `~`, an explicit `>=` is replaced and the `<` beside it
 * kept verbatim. A notation with no floor of its own — `1.x`, `*`, a union — takes the
 * first of `^`, `~`, `>=` that means the same thing, and a range none of them can say
 * is written out as its bounds: `^0` at `0.5.2` becomes `>=0.5.2 <1`, because a caret
 * on `0.5.2` would stop at `0.6.0`. No candidate is trusted: each is compared against
 * the declared range, and when none matches the range is `kept`.
 *
 * **With `--latest` the range is dropped and its operator is not**, as Yarn Berry's
 * `yarn up` keeps a `^` or `~`: `~1.2.0` becomes `~4.0.0` and an exact pin stays
 * exact. A range with no single operator — explicit bounds, `1.x`, a union — becomes
 * the caret `rarn add` writes, since its bounds are what `--latest` says to ignore.
 */
export function upgradeRange(
  declared: string,
  published: readonly string[],
  latest: boolean,
): RangeUpgrade {
  return upgradeRanges([declared], published, latest)[0] ?? UNCHANGED
}

/**
 * `upgradeRange` for every range one package is declared with, one per manifest section
 * it appears in. They are raised together because they are installed together: the
 * resolver gives them one version wherever one version will do.
 *
 * Raised one at a time, each would take the newest its own range allows, and `^1.2.0`
 * beside `~1.2.0` would become `^1.3.0` beside `~1.2.5` — two ranges no version
 * satisfies, written into the manifest before the install that fails on them, and on
 * every install after it. Here each floor moves to the version an install would choose for it, so the
 * pair becomes `^1.2.5` and `~1.2.5`.
 *
 * `--latest` needs none of this: every range it writes names the same newest release.
 */
export function upgradeRanges(
  declared: readonly string[],
  published: readonly string[],
  latest: boolean,
): RangeUpgrade[] {
  const ranges = declared.map(normalizeRange)

  if (latest) {
    const newest = semver.maxSatisfying(stableOnly(published), '*')
    if (newest === null) return ranges.map(() => UNCHANGED)
    return ranges.map((range) => {
      const next = `${latestOperator(range)}${newest}`
      return equivalent(next, range) ? UNCHANGED : { kind: 'raised', range: next }
    })
  }

  const targets = upgradeTargets(ranges, published)
  return ranges.map((range, index) => {
    const target = targets[index]
    return target === undefined ? UNCHANGED : raiseFloor(range, target)
  })
}

/**
 * The version a plain `rarn up` moves each of one package's declared ranges to, or
 * undefined where it leaves the range alone.
 *
 * Asked of `selectVersions`, the resolver's own choice, rather than worked out again:
 * ranges one version satisfies share the newest such version, and ranges that need two
 * majors get one each. Where no stable release can satisfy them all, every range is
 * left as written. That is usually a conflict, which the install reports exactly as it
 * would have without `up`, and rewriting one means guessing which side was meant.
 *
 * Only the direct ranges are asked. A transitive requirement on the same package is
 * not in view here, so it can still refuse what these ranges are raised to.
 */
export function upgradeTargets(
  declared: readonly string[],
  published: readonly string[],
): (string | undefined)[] {
  // Placement decides where a chosen version lands, never which one is chosen, so any
  // value serves.
  const constraints = declared.map(
    (range): Constraint => ({ from: 'root', range: normalizeRange(range), placement: 'shared' }),
  )
  const available = stableOnly(published).map((version) => ({ version }))
  const selection = selectVersions(available, constraints)
  if (selection.unsatisfiable.length > 0) return constraints.map(() => undefined)
  return constraints.map(
    (constraint) =>
      selection.groups.find((group) => group.constraints.includes(constraint))?.version,
  )
}

/**
 * Never proposed, only ever kept: a prerelease is something a person opts into by
 * naming it, and `up` names versions on their behalf.
 */
function stableOnly(published: readonly string[]): string[] {
  return published.filter((version) => semver.prerelease(version) === null)
}

function raiseFloor(range: string, newest: string): RangeUpgrade {
  const wanted = atOrAbove(range, newest)
  if (equivalent(wanted, range)) return UNCHANGED

  // `equivalent` reads prereleases the way `semver` does by default, and the resolver
  // does not: it counts them. Read its way, a rewrite still may not reach outside the
  // declared range — a hyphen's floor turns into `-0` and can — and may not name a
  // prerelease the person did not, since the resolver takes any range that names one
  // as asking for prereleases and would opt the project in.
  const faithful = (candidate: string): boolean =>
    equivalent(candidate, wanted) &&
    semver.subset(candidate, range, { includePrerelease: true }) &&
    (rangeMentionsPrerelease(range) || !rangeMentionsPrerelease(candidate))
  const raised = floorCandidates(range, newest).find(faithful)
  return raised === undefined ? { kind: 'kept', newest } : { kind: 'raised', range: raised }
}

/** `^` or `~` when the whole range is one operator on one version, like `~1.2.0`. */
function singleOperator(range: string): '^' | '~' | undefined {
  if (/\s|\|\|/.test(range)) return undefined
  if (range.startsWith('^')) return '^'
  // `~>` is npm's other spelling of a tilde.
  if (range.startsWith('~')) return '~'
  return undefined
}

/**
 * `1.2.3` and `=1.2.3` both pin, and the second is not decoration: it is Cargo's
 * exact requirement, which `rarn import` writes through as it found it. A check that
 * reads only the bare spelling turns every imported pin into a range.
 */
function pinPrefix(range: string): '=' | '' | undefined {
  if (semver.valid(range.replace(/^=/, '')) === null) return undefined
  return range.startsWith('=') ? '=' : ''
}

function latestOperator(range: string): string {
  return pinPrefix(range) ?? singleOperator(range) ?? '^'
}

/** Rewrites that raise the floor, most faithful to the declared notation first. */
function floorCandidates(range: string, newest: string): string[] {
  const candidates: string[] = []

  const operator = singleOperator(range)
  if (operator !== undefined) candidates.push(`${operator}${newest}`)

  const comparators = range.split(' ')
  if (comparators.every((c) => /^(?:>=|>|<=|<)\d/.test(c))) {
    const ceiling = comparators.filter((c) => c.startsWith('<'))
    candidates.push([`>=${newest}`, ...ceiling].join(' '))
  }

  const hyphen = /^(\S+) - (\S+)$/.exec(range)
  if (hyphen !== null) candidates.push(`${newest} - ${hyphen[2] ?? ''}`)

  candidates.push(`^${newest}`, `~${newest}`, `>=${newest}`, spelledOut(range, newest))
  return candidates
}

/**
 * The rewrite for a range no single operator can raise: each alternative cut at
 * `newest` and written as its bounds. `^0` at `0.5.2` is the case that needs it — a
 * caret on `0.5.2` stops at `0.6.0` — and so is a caret with a bound beside it.
 *
 * An alternative wholly below `newest` is dropped and one that starts at or above it
 * is kept as written; only one that straddles it is rewritten, to `>=newest` and the
 * tightest ceiling it already had.
 */
function spelledOut(range: string, newest: string): string {
  const floor = `>=${newest}`
  return range
    .split('||')
    .map((alternative) => alternative.trim())
    .flatMap((alternative) => {
      if (startsAt(alternative, newest)) return [alternative]
      if (!semver.intersects(alternative, floor)) return []
      const ceilings = new semver.Range(alternative).set
        .flat()
        .filter((c) => c.operator === '<' || c.operator === '<=')
      const ceiling = ceilings.reduce<semver.Comparator | undefined>(
        (tightest, c) => (tightest === undefined || tighter(c, tightest) ? c : tightest),
        undefined,
      )
      return [ceiling === undefined ? floor : `${floor} ${written(ceiling)}`]
    })
    .join(' || ')
}

function tighter(a: semver.Comparator, b: semver.Comparator): boolean {
  const order = semver.compare(a.semver, b.semver)
  return order < 0 || (order === 0 && a.operator === '<')
}

/**
 * A caret's ceiling is stored as `<1.0.0-0`, and written back that way it names a
 * prerelease, which the resolver would take as asking for them. `<1` is the same
 * bound without one.
 */
function written(ceiling: semver.Comparator): string {
  const { major, minor, patch, prerelease } = ceiling.semver
  if (ceiling.operator !== '<' || patch !== 0 || prerelease.join('.') !== '0') {
    return ceiling.value
  }
  return minor === 0 ? `<${major}` : `<${major}.${minor}`
}

/**
 * `range` with everything below `floor` cut away, in whatever notation `semver`
 * accepts — it is compared against, never written. Each alternative of a union is
 * cut separately, since `a || b >=x` would bind the floor to `b` alone, and one that
 * already starts at the floor is left as it is, for `semver.subset`'s sake.
 */
function atOrAbove(range: string, floor: string): string {
  return new semver.Range(range).set
    .map((set) => set.map((comparator) => comparator.value).join(' '))
    .map((alternative) =>
      startsAt(alternative, floor) ? alternative : `${alternative} >=${floor}`.trim(),
    )
    .join(' || ')
}

/**
 * Whether `alternative` admits nothing below `version`. Asked of `semver.minVersion`
 * because `semver.subset` answers a different question. It reasons in intervals, so
 * `>1.2.2` is not inside `>=1.2.3`; and `^1.1.2-0` is not inside `>=1.0.2`, rightly —
 * it admits `1.1.2-0` by name, and `>=1.0.2` excludes every prerelease — although
 * nothing it admits is below `1.0.2`.
 */
function startsAt(alternative: string, version: string): boolean {
  const lowest = semver.minVersion(alternative)
  return lowest !== null && semver.gte(lowest, version)
}

/**
 * Compared the way `semver` reads a range by default, where a prerelease counts only
 * if the range names one. The resolver counts them once any range on the package
 * does, and read that way `^1.9` admits a `1.9.0-rc.1` that `^1.9.0` does not — so
 * equality under that reading would call `^1.9` out of date at `1.9.0`. The direction
 * that matters, admitting nothing the person excluded, `upgradeRange` checks under the
 * resolver's reading separately.
 *
 * Alternatives nothing satisfies are dropped first. `semver.subset` rejects one that
 * follows a satisfiable alternative and accepts one that precedes it, so a cut that
 * emptied `^1.0.0` made `^2.0.0 || ^1.0.0` unraisable at 2.3.0 while the same union
 * written the other way round was raised.
 */
function equivalent(a: string, b: string): boolean {
  const [x, y] = [satisfiable(a), satisfiable(b)]
  return semver.subset(x, y) && semver.subset(y, x)
}

function satisfiable(range: string): string {
  const alternatives = new semver.Range(range).set
    .map((set) => set.map((comparator) => comparator.value).join(' '))
    .filter((alternative) => semver.minVersion(alternative) !== null)
  // Joined, nothing at all would read as `*`; this is `semver`'s own empty range.
  return alternatives.length === 0 ? '<0.0.0-0' : alternatives.join(' || ')
}
