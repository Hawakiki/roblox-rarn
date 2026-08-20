import type { DependencySection, Realm } from '../manifest/types.ts'
import type { PackageName } from '../util/package-name.ts'

/** Where a package ends up. Not always the realm the registry declared. */
export type Placement = 'shared' | 'server' | 'dev'

/** One demand for a package: who wants it, and in what range. */
export interface Constraint {
  /** A package key, or `'root'` for a direct dependency of `rarn.json`. */
  readonly from: string
  /** npm syntax, already normalized. */
  readonly range: string
  /** Which realm this demand came through; decides placement. */
  readonly placement: Placement
}

/** A package that survived resolution. */
export interface ResolvedPackage {
  readonly name: PackageName
  readonly version: string
  /** What the registry declared. */
  readonly realm: Realm
  /** Which directory it lands in — the widest placement any requester asked for. */
  readonly placement: Placement
  /** Alias the package's source requires, to the package key it resolves to. */
  readonly dependencies: ReadonlyMap<string, string>
  /** Every requester and range, in stable order. Powers `rarn why`. */
  readonly requestedBy: readonly Constraint[]
  /** True when reachable only through devDependencies. */
  readonly dev: boolean
  /** Set when a `resolutions` entry forced this version. */
  readonly forcedBy: 'resolutions' | undefined
}

export interface Resolution {
  /** Keyed by `@scope/name@version`, in sorted order. */
  readonly packages: ReadonlyMap<string, ResolvedPackage>
  /** Packages installed at more than one version, keyed by `@scope/name`. */
  readonly duplicates: ReadonlyMap<string, readonly string[]>
  /** Applied `resolutions` overrides, for reporting. */
  readonly overrides: ReadonlyMap<string, string>
}

/** Maps a manifest section to the placement its demands carry. */
export const SECTION_PLACEMENT: Record<DependencySection, Placement> = {
  dependencies: 'shared',
  serverDependencies: 'server',
  devDependencies: 'dev',
}

/**
 * Placement precedence: the **widest** requester wins.
 *
 * A package has to live where its most permissive requester can still reach it. If
 * anything needs it in `shared`, burying it in `server` would leave the client
 * unable to see it, so `shared` wins. `dev` only survives when nothing else wants
 * the package at all.
 */
const PLACEMENT_RANK: Record<Placement, number> = { shared: 3, server: 2, dev: 1 }

export function widestPlacement(a: Placement, b: Placement): Placement {
  return PLACEMENT_RANK[a] >= PLACEMENT_RANK[b] ? a : b
}

/**
 * Whether a requester in `from` may depend on a package declared as `realm`.
 *
 * Mirrors Wally's rule. The one that bites: **`shared` may only depend on
 * `shared`** — shared code replicates to clients, so a shared→server edge is code
 * that cannot exist at runtime on the client that loaded it.
 */
export function isDependencyAllowed(from: Placement, realm: Realm): boolean {
  if (from === 'shared') return realm === 'shared'
  return true
}
