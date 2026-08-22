import semver from 'semver'
import type { NormalizedManifest } from '../manifest/types.ts'
import { DEPENDENCY_SECTIONS } from '../manifest/types.ts'
import type { PackageMetadata, PackageVersion, RegistryClient } from '../registry/types.ts'
import { Code } from '../util/codes.ts'
import { METADATA_CONCURRENCY, mapWithConcurrency } from '../util/concurrency.ts'
import { RarnError } from '../util/errors.ts'
import {
  type PackageName,
  parsePackageName,
  toPackageKey,
  toWallyName,
} from '../util/package-name.ts'
import { areCompatible, normalizeRange } from '../util/version-range.ts'
import { describeConflict, describeRealmViolation, describeUnsatisfiable } from './conflict.ts'
import { selectVersions } from './select.ts'
import {
  type Constraint,
  type Placement,
  type Resolution,
  type ResolvedPackage,
  SECTION_PLACEMENT,
  isDependencyAllowed,
  widestPlacement,
} from './types.ts'

/**
 * Guard against a resolution that never settles.
 *
 * Convergence is expected within roughly graph-depth rounds. It is not *proven*,
 * though: lowering a version changes its dependencies, which can retract a constraint
 * elsewhere and let a different version rise again. Rather than risk a hang, stop and
 * say so — silently shipping whichever half-settled answer the loop happened to hold
 * would be worse than an honest failure.
 */
const MAX_ROUNDS = 100

/** One requester-to-package edge, before placement is known. */
interface Edge {
  /** A package key, or `'root'`. */
  readonly from: string
  /** Wally name of the package being requested. */
  readonly to: string
  readonly range: string
  /**
   * Placement this edge forces regardless of its requester.
   *
   * Set for root sections and for a package's `[server-dependencies]`. When absent,
   * the edge inherits whatever placement its requester ends up with.
   */
  readonly forces: Placement | undefined
}

export interface ResolveOptions {
  manifest: NormalizedManifest
  registry: RegistryClient
  /** Skips devDependencies, for `--production`. */
  production?: boolean
}

export async function resolve(options: ResolveOptions): Promise<Resolution> {
  const { manifest, registry, production = false } = options

  const rootEdges = collectRootEdges(manifest, production)
  const overrides = normalizeOverrides(manifest.resolutions)
  const metadata = new Map<string, PackageMetadata>()

  /** wally name -> chosen versions. Rebuilt from scratch every round. */
  let chosen = new Map<string, string[]>()

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const edges = buildEdges(rootEdges, chosen, metadata)
    await fetchMissing(edges, metadata, registry)

    const constraints = withPlacements(edges)
    const next = solveRound(constraints, metadata, overrides)

    if (sameSelection(chosen, next)) {
      return assemble(constraints, next, metadata, overrides)
    }
    chosen = next
  }

  throw new RarnError({
    code: Code.InternalError,
    what: `Dependency resolution did not settle after ${MAX_ROUNDS} rounds.`,
    how: 'This is a bug in Rarn. Please report it along with your rarn.json.',
  })
}

/** Direct dependencies of `rarn.json`. Their placement is fixed by their section. */
function collectRootEdges(manifest: NormalizedManifest, production: boolean): Edge[] {
  const edges: Edge[] = []

  for (const section of DEPENDENCY_SECTIONS) {
    if (production && section === 'devDependencies') continue

    for (const [rarnName, range] of Object.entries(manifest[section])) {
      edges.push({
        from: 'root',
        to: toWallyName(parsePackageName(rarnName)),
        range: normalizeRange(range),
        forces: SECTION_PLACEMENT[section],
      })
    }
  }

  return edges
}

/**
 * Rebuilds every edge from the root plus the currently chosen versions.
 *
 * Rebuilt rather than updated in place. An incremental update would have to retract
 * exactly the edges a dropped version contributed, and getting that bookkeeping wrong
 * over-constrains the graph *silently* — resolution keeps succeeding and just picks a
 * lower version than it should. Metadata is cached, so rebuilding costs nothing.
 */
function buildEdges(
  rootEdges: readonly Edge[],
  chosen: ReadonlyMap<string, string[]>,
  metadata: ReadonlyMap<string, PackageMetadata>,
): Edge[] {
  const edges = [...rootEdges]

  for (const [name, versions] of chosen) {
    for (const version of versions) {
      const entry = findVersion(metadata, name, version)
      if (entry === undefined) continue
      const from = toPackageKey(entry.name, version)

      for (const [, req] of entry.dependencies) {
        edges.push({ from, to: toWallyName(req.name), range: req.range, forces: undefined })
      }
      for (const [, req] of entry.serverDependencies) {
        edges.push({ from, to: toWallyName(req.name), range: req.range, forces: 'server' })
      }
    }
  }

  return edges
}

/**
 * Fetches metadata for every package named by an edge, with a bounded pool.
 *
 * Bounded rather than `Promise.all` over the whole round. Resolution walks the graph
 * breadth-first, so one round is every package at one depth — for a project with 506
 * direct dependencies that is 506 requests opened at the same instant. Measured, that
 * is twelve times slower than running 32 at a time, and the shape is a cliff rather
 * than a slope: 32 takes 1.8s where unbounded takes 21.9s on the same 150 packages.
 *
 * Downloads were already bounded. Metadata was not, and it is the larger of the two
 * on a wide graph because every package is asked about while only the chosen ones are
 * downloaded.
 */
async function fetchMissing(
  edges: readonly Edge[],
  metadata: Map<string, PackageMetadata>,
  registry: RegistryClient,
): Promise<void> {
  const missing = [...new Set(edges.map((e) => e.to))].filter((name) => !metadata.has(name))
  const fetched = await mapWithConcurrency(missing, METADATA_CONCURRENCY, (name) =>
    registry.getMetadata(toPackageName(name)),
  )
  for (const [index, name] of missing.entries()) {
    const entry = fetched[index]
    if (entry !== undefined) metadata.set(name, entry)
  }
}

/**
 * Assigns each package the widest placement any path to it carries.
 *
 * Placement is circular by nature: an edge inherits its requester's placement, which
 * depends on the edges pointing at *it*. Solved by relaxation — start everything at
 * the narrowest realm and widen repeatedly until nothing moves. That terminates
 * because `widestPlacement` only ever moves a value up, through three levels.
 */
function withPlacements(edges: readonly Edge[]): Map<string, Constraint[]> {
  const placement = new Map<string, Placement>()

  for (let pass = 0; pass < edges.length + 1; pass++) {
    let changed = false

    for (const edge of edges) {
      const carried = edge.forces ?? placementOfRequester(edge.from, placement)
      if (carried === undefined) continue

      const current = placement.get(edge.to)
      const widened = current === undefined ? carried : widestPlacement(current, carried)
      if (widened !== current) {
        placement.set(edge.to, widened)
        changed = true
      }
    }

    if (!changed) break
  }

  const constraints = new Map<string, Constraint[]>()
  for (const edge of edges) {
    const carried = edge.forces ?? placementOfRequester(edge.from, placement) ?? 'dev'
    push(constraints, edge.to, { from: edge.from, range: edge.range, placement: carried })
  }
  return constraints
}

/** A requester's placement, or undefined while it is still unknown. */
function placementOfRequester(
  from: string,
  placement: ReadonlyMap<string, Placement>,
): Placement | undefined {
  if (from === 'root') return undefined
  // `@scope/name@version` -> `scope/name`
  const at = from.lastIndexOf('@')
  return placement.get(from.slice(1, at))
}

/** Solves each package independently from the constraints on it. */
function solveRound(
  constraints: ReadonlyMap<string, Constraint[]>,
  metadata: ReadonlyMap<string, PackageMetadata>,
  overrides: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const next = new Map<string, string[]>()

  // Sorted so a rerun produces byte-identical output; the lockfile depends on it.
  for (const name of [...constraints.keys()].sort()) {
    const meta = metadata.get(name)
    if (meta === undefined) continue
    const result = selectVersions(meta.versions, constraints.get(name) ?? [], overrides.get(name))
    if (result.groups.length > 0)
      next.set(
        name,
        result.groups.map((g) => g.version),
      )
  }

  return next
}

function sameSelection(
  a: ReadonlyMap<string, string[]>,
  b: ReadonlyMap<string, string[]>,
): boolean {
  if (a.size !== b.size) return false
  for (const [name, versions] of a) {
    const other = b.get(name)
    if (other === undefined || other.length !== versions.length) return false
    if (versions.some((v, i) => other[i] !== v)) return false
  }
  return true
}

/**
 * Builds the final result, and only now reports failures.
 *
 * Errors wait until the loop has settled so they describe the real, final graph.
 * Reporting mid-loop would surface intermediate states that a later round fixes.
 */
function assemble(
  constraints: ReadonlyMap<string, Constraint[]>,
  chosen: ReadonlyMap<string, string[]>,
  metadata: ReadonlyMap<string, PackageMetadata>,
  overrides: ReadonlyMap<string, string>,
): Resolution {
  const packages = new Map<string, ResolvedPackage>()
  const duplicates = new Map<string, string[]>()
  const applied = new Map<string, string>()

  // Iterates the *constraints*, not the chosen versions. A package nothing could
  // satisfy never makes it into `chosen`, so walking `chosen` would drop it silently
  // — the install would simply omit a declared dependency and report success.
  for (const name of [...constraints.keys()].sort()) {
    const meta = metadata.get(name)
    if (meta === undefined) continue

    const list = constraints.get(name) ?? []
    const override = overrides.get(name)
    const result = selectVersions(meta.versions, list, override)

    if (result.unsatisfiable.length > 0) {
      throw new RarnError({
        code: Code.UnresolvableRange,
        what: `No published version of ${name} satisfies every requirement.`,
        detail: describeUnsatisfiable(name, meta, result.unsatisfiable),
        how: `Check the ranges above, or pin a version with "resolutions": { "@${name}": "x.y.z" }.`,
      })
    }

    const versions = result.groups.map((g) => g.version)
    if (versions.length > 1) duplicates.set(`@${name}`, versions)
    if (override !== undefined) applied.set(`@${name}`, override)

    for (const group of result.groups) {
      const entry = findVersion(metadata, name, group.version)
      if (entry === undefined) continue

      const placement = group.constraints.reduce<Placement>(
        (acc, c) => widestPlacement(acc, c.placement),
        'dev',
      )
      assertRealmAllowed(entry, group.constraints)

      packages.set(toPackageKey(entry.name, group.version), {
        name: entry.name,
        version: group.version,
        realm: entry.realm,
        placement,
        dependencies: resolveDependencyLinks(entry, chosen),
        requestedBy: [...group.constraints].sort(compareConstraints),
        dev: placement === 'dev',
        forcedBy: override === undefined ? undefined : 'resolutions',
      })
    }
  }

  reportCompatibleDuplicates(duplicates, constraints)
  return { packages, duplicates, overrides: applied }
}

/**
 * Maps each alias in a package's source to the package key it resolves to.
 *
 * The alias is the key because the package's own code says `require(...Promise)` —
 * the linker has to know that `Promise` *here* means this exact resolved version.
 * When several majors are installed, each requester gets the one its range allows.
 */
function resolveDependencyLinks(
  entry: PackageVersion,
  chosen: ReadonlyMap<string, string[]>,
): Map<string, string> {
  const links = new Map<string, string>()

  for (const [alias, req] of [...entry.dependencies, ...entry.serverDependencies]) {
    const versions = chosen.get(toWallyName(req.name)) ?? []
    const match =
      versions.find((v) => semver.satisfies(v, req.range, { includePrerelease: true })) ??
      versions[0]
    if (match !== undefined) links.set(alias, toPackageKey(req.name, match))
  }

  return links
}

/** A `shared` package may only depend on `shared` packages. */
function assertRealmAllowed(entry: PackageVersion, constraints: readonly Constraint[]): void {
  const offender = constraints.find((c) => !isDependencyAllowed(c.placement, entry.realm))
  if (offender === undefined) return

  throw new RarnError({
    code: Code.RealmViolation,
    what: `${toWallyName(entry.name)}@${entry.version} is a '${entry.realm}' package, but ${offender.from} needs it in '${offender.placement}'.`,
    detail: describeRealmViolation(entry, offender),
    how: "A 'shared' package may only depend on other 'shared' packages: shared code replicates to clients, which have no server-only code to find.",
  })
}

/**
 * Refuses two semver-compatible copies of the same package.
 *
 * Incompatible majors coexisting is normal and allowed. Two versions inside the *same*
 * major would be two ModuleScript instances of code that claims to be interchangeable —
 * the singleton hazard — and the selector never produces that on purpose, so reaching
 * here means a Rarn bug rather than a user mistake.
 */
function reportCompatibleDuplicates(
  duplicates: ReadonlyMap<string, readonly string[]>,
  constraints: ReadonlyMap<string, Constraint[]>,
): void {
  for (const [name, versions] of duplicates) {
    const wally = name.slice(1)
    // Uses `areCompatible`, not a major-number comparison: for a `0.x` release the
    // breaking axis is the minor, so `0.2.0` and `0.3.0` share a major yet are not
    // interchangeable. Comparing majors here would report a legitimate pair of
    // incompatible versions as a bug.
    const clash = versions.some((a, i) => versions.some((b, j) => i < j && areCompatible(a, b)))
    if (!clash) continue

    throw new RarnError({
      code: Code.DuplicateMajorInstalled,
      what: `${name} would be installed twice within one major version.`,
      detail: describeConflict(wally, versions, constraints.get(wally) ?? []),
      how: 'This is a bug in Rarn — compatible versions should have been unified. Please report it.',
    })
  }
}

function compareConstraints(a: Constraint, b: Constraint): number {
  return a.from === b.from ? a.range.localeCompare(b.range) : a.from.localeCompare(b.from)
}

function normalizeOverrides(resolutions: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [rarnName, version] of Object.entries(resolutions)) {
    out.set(toWallyName(parsePackageName(rarnName)), version)
  }
  return out
}

function findVersion(
  metadata: ReadonlyMap<string, PackageMetadata>,
  name: string,
  version: string,
): PackageVersion | undefined {
  return metadata.get(name)?.versions.find((v) => v.version === version)
}

function toPackageName(wallyName: string): PackageName {
  return parsePackageName(`@${wallyName}`)
}

function push(map: Map<string, Constraint[]>, key: string, value: Constraint): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}
