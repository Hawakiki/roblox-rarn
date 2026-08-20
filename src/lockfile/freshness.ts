import semver from 'semver'
import { DEPENDENCY_SECTIONS, type NormalizedManifest } from '../manifest/types.ts'
import { normalizeRange } from '../util/version-range.ts'
import type { Lockfile } from './types.ts'

export interface Freshness {
  readonly fresh: boolean
  /** Human-readable reasons the lockfile cannot be reused. Empty when fresh. */
  readonly reasons: readonly string[]
}

/**
 * Decides whether a lockfile still describes what `rarn.json` asks for.
 *
 * The asymmetry here matters. Being too strict costs a network round trip and some
 * seconds. Being too lax installs versions the manifest no longer asks for **and
 * reports success** — the failure mode where nothing looks wrong until much later.
 * So every comparison below errs toward declaring the lockfile stale.
 *
 * Only inputs to *resolution* are compared. `packageDir`, `place` and `aliases`
 * change where files land, and linking runs on every install regardless, so treating
 * them as invalidating would force a full re-resolution over a renamed directory.
 */
export function checkFreshness(lockfile: Lockfile, manifest: NormalizedManifest): Freshness {
  const reasons: string[] = []

  // Compares the *index* the manifest names, not the lockfile's top-level `registry`,
  // which records the API base the archives came from. They are different values —
  // a repository URL and an API URL — and comparing across them makes every lockfile
  // look stale forever.
  const lockedIndex = lockfile.root.registry
  if (lockedIndex !== undefined && lockedIndex !== manifest.registry) {
    reasons.push(`registry changed (${lockedIndex} -> ${manifest.registry})`)
  }

  for (const section of DEPENDENCY_SECTIONS) {
    reasons.push(...compare(section, lockfile.root[section] ?? {}, manifest[section]))
  }

  reasons.push(
    ...compare('resolutions', lockfile.root.resolutions ?? {}, manifest.resolutions, false),
  )

  // Every declared dependency must actually be present. A lockfile can pass the
  // comparisons above and still be missing entries if it was hand-edited or written
  // by an interrupted run.
  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(manifest[section])) {
      if (!hasPackage(lockfile, name)) {
        reasons.push(`${name} is declared but missing from the lockfile`)
      }
    }
  }

  return { fresh: reasons.length === 0, reasons }
}

/**
 * Compares one section, treating equivalent ranges as equal.
 *
 * `^1.0.0` and `>=1.0.0, <2.0.0` mean the same thing but are different strings, so a
 * plain comparison would call a lockfile stale over a reformatted manifest. Ranges go
 * through the same normalizer the resolver uses, which is also what stops a Cargo
 * range and its npm translation from looking like a change.
 */
function compare(
  section: string,
  locked: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
  asRange = true,
): string[] {
  const reasons: string[] = []
  const names = new Set([...Object.keys(locked), ...Object.keys(current)])

  for (const name of [...names].sort()) {
    const before = locked[name]
    const after = current[name]

    if (before === undefined) {
      reasons.push(`${name} was added to ${section}`)
    } else if (after === undefined) {
      reasons.push(`${name} was removed from ${section}`)
    } else if (asRange ? !sameRange(before, after) : before !== after) {
      reasons.push(`${name} changed in ${section} (${before} -> ${after})`)
    }
  }

  return reasons
}

/**
 * Whether two ranges mean the same thing, not whether they are spelled the same.
 *
 * Compared in `semver`'s canonical form so that rewriting `^1.0.0` as `1.x` does not
 * invalidate a lockfile — the requirement did not change, only the notation. The
 * canonical form is also precise about prereleases, which raw text is not: `^1.0.0`
 * expands to `>=1.0.0 <2.0.0-0` and `>=1.0.0 <2.0.0` does not, so those two really
 * are different requirements and are correctly treated as a change.
 */
function sameRange(a: string, b: string): boolean {
  try {
    const left = semver.validRange(normalizeRange(a))
    const right = semver.validRange(normalizeRange(b))
    if (left !== null && right !== null) return left === right
  } catch {
    // Fall through: an unparseable range can only be compared as text.
  }
  return a === b
}

function hasPackage(lockfile: Lockfile, rarnName: string): boolean {
  const prefix = `${rarnName}@`
  return Object.keys(lockfile.packages).some((key) => key.startsWith(prefix))
}
