import semver from 'semver'
import type { PackageVersion } from '../registry/types.ts'
import { areCompatible } from '../util/version-range.ts'
import type { Constraint } from './types.ts'

/** One group of constraints that a single version can satisfy. */
export interface VersionGroup {
  readonly version: string
  readonly constraints: readonly Constraint[]
}

export interface SelectionResult {
  /** Chosen versions, newest first. More than one means the ranges did not unify. */
  readonly groups: readonly VersionGroup[]
  /** Constraints no published version satisfies. Non-empty means failure. */
  readonly unsatisfiable: readonly Constraint[]
}

/**
 * Chooses the fewest versions that satisfy every constraint.
 *
 * The whole point is that this looks at **all** constraints at once. Wally picks
 * greedily while walking the graph, so `^1.2.0` and `^1.5.0` can fail: whichever
 * arrives first activates `1.2.0`, and every later `1.x` candidate is then rejected
 * as "compatible with something already chosen". Intersecting first yields `1.9.0`
 * for both, and the outcome does not depend on visit order.
 *
 * Two versions of the same package are only ever returned when their ranges are
 * genuinely incompatible (different majors). Compatible duplicates are the Roblox
 * singleton hazard and are never produced deliberately.
 */
export function selectVersions(
  available: readonly Pick<PackageVersion, 'version'>[],
  constraints: readonly Constraint[],
  forced?: string,
): SelectionResult {
  if (constraints.length === 0) return { groups: [], unsatisfiable: [] }

  const candidates = eligibleVersions(available, constraints)

  // A `resolutions` entry replaces resolution entirely: that is what makes it an
  // escape hatch. Constraints it violates are reported by the caller, not here —
  // overriding away a conflict is the documented purpose, not an error.
  if (forced !== undefined) {
    return available.some((v) => v.version === forced)
      ? { groups: [{ version: forced, constraints }], unsatisfiable: [] }
      : { groups: [], unsatisfiable: constraints }
  }

  const satisfiable: Constraint[] = []
  const unsatisfiable: Constraint[] = []
  for (const constraint of constraints) {
    const anyMatch = candidates.some((v) => semver.satisfies(v, constraint.range, OPTS))
    ;(anyMatch ? satisfiable : unsatisfiable).push(constraint)
  }
  if (satisfiable.length === 0) return { groups: [], unsatisfiable }

  // A constraint that no version satisfies and one that no *compatible* version
  // satisfies are the same answer to the caller: no published version meets every
  // requirement. They differ only in how far the resolver got before knowing.
  const selection = groupConstraints(candidates, satisfiable)
  return {
    groups: selection.groups,
    unsatisfiable: [...unsatisfiable, ...selection.conflicted],
  }
}

const OPTS = { includePrerelease: true } as const

/**
 * Candidate versions, with prereleases excluded unless something asked for one.
 *
 * A prerelease is opt-in: `*` or `^1.0.0` must never quietly resolve to `2.0.0-rc.1`.
 * But `evaera/promise` publishes `4.0.0` and `4.0.0-rc.2` side by side with no tag
 * distinguishing them, so a range that names a prerelease has to keep working.
 */
function eligibleVersions(
  available: readonly Pick<PackageVersion, 'version'>[],
  constraints: readonly Constraint[],
): string[] {
  const wantsPrerelease = constraints.some((c) => rangeMentionsPrerelease(c.range))
  const versions = available
    .map((v) => v.version)
    .filter((v) => wantsPrerelease || semver.prerelease(v) === null)
  return versions.sort((a, b) => semver.rcompare(a, b))
}

export function rangeMentionsPrerelease(range: string): boolean {
  return /\d+\.\d+\.\d+-/.test(range)
}

/**
 * Partitions constraints into the fewest groups a single version can each satisfy.
 *
 * Greedy, and deliberately so. Optimal partitioning is set-cover, but the input is
 * tiny — the measured Roblox ecosystem has shallow graphs, and a package with more
 * than a couple of distinct ranges on it is already unusual. Greedy on
 * highest-version-first also produces the answer a person expects: the newest
 * version that works absorbs as many requesters as it can.
 */
function groupConstraints(
  candidates: readonly string[],
  constraints: readonly Constraint[],
): { groups: VersionGroup[]; conflicted: Constraint[] } {
  const remaining = [...constraints]
  const groups: VersionGroup[] = []

  while (remaining.length > 0) {
    // Highest version that satisfies the most still-unassigned constraints. Ties go
    // to the higher version because `candidates` is sorted descending.
    let best: { version: string; matched: Constraint[] } | undefined
    for (const version of candidates) {
      const matched = remaining.filter((c) => semver.satisfies(version, c.range, OPTS))
      if (matched.length === 0) continue
      if (best === undefined || matched.length > best.matched.length) {
        best = { version, matched }
      }
    }

    // Guarded by the caller: every constraint here matched at least one candidate.
    if (best === undefined) break

    groups.push({ version: best.version, constraints: best.matched })
    for (const c of best.matched) remaining.splice(remaining.indexOf(c), 1)
  }

  return mergeCompatible(groups)
}

/**
 * Collapses groups whose versions are semver-compatible.
 *
 * Greedy grouping can land on `1.2.0` and `1.9.0` as separate groups when no single
 * version covered everything in one pass. Shipping both would be exactly the
 * duplicate that breaks singletons, so one of them has to go.
 *
 * **The survivor must still satisfy everything it absorbs.** "They share a major, so
 * the higher one substitutes for the lower" is semver's contract for a *caret*
 * requirement and for nothing else. `~1.2.0` and `^1.5.0` share a major and have an
 * empty intersection: merging them silently produced `1.9.0` carrying `~1.2.0` as a
 * satisfied constraint, installed a version that does not satisfy it, and wrote the
 * violated range into the lockfile beside it. Constraint 5 says to report a conflict
 * exactly when the intersection is genuinely empty — and it was.
 *
 * Constraints the survivor cannot satisfy come back as conflicts. There is no third
 * option: keeping both versions is the compatible duplicate constraint 1 forbids, and
 * no other version can satisfy both or the grouping pass would have found it.
 */
function mergeCompatible(groups: readonly VersionGroup[]): {
  groups: VersionGroup[]
  conflicted: Constraint[]
} {
  const merged: { version: string; constraints: Constraint[] }[] = []
  const conflicted: Constraint[] = []

  for (const group of groups) {
    const existing = merged.find((m) => areCompatible(m.version, group.version))
    if (existing === undefined) {
      merged.push({ version: group.version, constraints: [...group.constraints] })
      continue
    }

    const survivor = semver.gt(group.version, existing.version) ? group.version : existing.version

    // Every constraint is re-checked, not just the incoming ones: raising the
    // survivor can break a constraint the existing group already held.
    const all = [...existing.constraints, ...group.constraints]
    existing.version = survivor
    existing.constraints = all.filter((c) => semver.satisfies(survivor, c.range, OPTS))
    conflicted.push(...all.filter((c) => !semver.satisfies(survivor, c.range, OPTS)))
  }

  return {
    groups: merged
      .sort((a, b) => semver.rcompare(a.version, b.version))
      .map((m) => ({ version: m.version, constraints: m.constraints })),
    conflicted,
  }
}
