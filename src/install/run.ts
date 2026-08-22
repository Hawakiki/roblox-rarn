import { resolve as resolvePath } from 'node:path'
import { fetchPackages } from '../cache/fetch.ts'
import { type CacheStore, createCacheStore } from '../cache/store.ts'
import { type PlaceReport, scanPlaces } from '../doctor/places.ts'
import { type LinkResult, link } from '../linker/link.ts'
import { checkFreshness } from '../lockfile/freshness.ts'
import { readLockfile, resolutionFromLockfile } from '../lockfile/read.ts'
import { LOCKFILE_NAME } from '../lockfile/types.ts'
import { buildLockfile, writeLockfile } from '../lockfile/write.ts'
import { readManifest } from '../manifest/read.ts'
import { type NormalizedManifest, realmDirs } from '../manifest/types.ts'
import { resolvePlace, unmountedRealms } from '../project/place.ts'
import { DEFAULT_API_URL, type RegistryClient } from '../registry/types.ts'
import { resolve } from '../resolver/resolve.ts'
import type { Resolution } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'

/**
 * The install pipeline: read, resolve (or reuse the lockfile), fetch, link, record.
 *
 * Lives outside `cli/` because the order of these stages is the product, not a
 * presentation detail. It used to be composed inside the command, which meant the one
 * thing no test could reach was the arrangement most likely to be wrong — RN-1 was a
 * question of *when* the ownership check ran relative to the download, not of what any
 * single stage did.
 *
 * Nothing here prints. Progress is reported through `onProgress` so that a caller with
 * no terminal — a test, or a driver running this over several projects — is a caller
 * like any other rather than a special case.
 */

/** Told what is happening, so the caller can decide whether to show it. */
export interface InstallObserver {
  /** A new stage began. */
  stage?(label: string): void
  /** One package finished fetching. */
  fetched?(
    pkg: { readonly key: string; readonly fromCache: boolean },
    done: number,
    total: number,
  ): void
  /** Why the lockfile could not be reused. Emitted before resolution starts. */
  stale?(reason: string): void
}

export interface InstallRequest {
  readonly projectDir: string
  readonly registry: RegistryClient
  /** Defaults to the global cache. Injected by tests so they never touch it. */
  readonly store?: CacheStore
  /** Drop devDependencies. The result no longer describes the manifest. */
  readonly production?: boolean
  /** Refuse to update a stale lockfile instead of rewriting it. For CI. */
  readonly frozenLockfile?: boolean
  readonly observer?: InstallObserver
}

export interface InstallOutcome {
  readonly manifest: NormalizedManifest
  /** Disagreements between rarn.json and the project's Rojo files. Worth printing. */
  readonly placeNotes: readonly string[]
  /**
   * Compatible duplicates this install's packages share a DataModel with.
   *
   * Only the compatible ones: two majors are two packages and belong in the report
   * someone asked for, while a compatible duplicate is a defect that no per-project
   * check can see, so it goes where it will actually be read.
   */
  readonly placeDuplicates: readonly PlaceReport[]
  readonly resolution: Resolution
  readonly link: LinkResult
  readonly cached: number
  readonly downloaded: number
  readonly elapsedMs: number
  /** Whether the lockfile was reused instead of re-resolving. */
  readonly fromLockfile: boolean
  /** Why the lockfile could not be reused, when it could not. */
  readonly staleReasons: readonly string[]
}

export async function runInstall(request: InstallRequest): Promise<InstallOutcome> {
  const started = performance.now()
  const projectDir = resolvePath(request.projectDir)
  const observer = request.observer ?? {}
  const production = request.production === true

  const manifest = await readManifest(projectDir)
  const lockfile = await readLockfile(projectDir)

  const freshness =
    lockfile === undefined
      ? { fresh: false, reasons: [`no ${LOCKFILE_NAME} yet`] }
      : checkFreshness(lockfile, manifest)

  if (request.frozenLockfile === true && !freshness.fresh) {
    throw new RarnError({
      code: Code.LockfileStale,
      what: `${LOCKFILE_NAME} does not match rarn.json.`,
      where: LOCKFILE_NAME,
      detail: freshness.reasons.map((reason) => `  ${reason}`).join('\n'),
      how: 'Run `rarn install` without --frozen-lockfile and commit the updated lockfile.',
    })
  }

  // `--production` drops devDependencies from the graph, so the result no longer
  // describes the manifest and must neither be reused from nor written back to it.
  const reuse = freshness.fresh && lockfile !== undefined && !production
  for (const reason of freshness.reasons) observer.stale?.(reason)

  let resolution: Resolution
  if (reuse) {
    resolution = resolutionFromLockfile(lockfile)
  } else {
    observer.stage?.('resolving dependencies')
    resolution = await resolve({
      manifest,
      registry: request.registry,
      ...(production ? { production: true } : {}),
    })
  }

  const store = request.store ?? createCacheStore()
  const total = resolution.packages.size
  observer.stage?.(`fetching ${total} packages`)
  const summary = await fetchPackages({
    packages: resolution.packages,
    registry: request.registry,
    store,
    ...(reuse ? { expectedIntegrity: integrityOf(lockfile) } : {}),
    onProgress: (pkg, done) => observer.fetched?.(pkg, done, total),
  })

  observer.stage?.('linking')
  const sources = new Map(summary.packages.map((p) => [p.key, p.dir]))

  // The Rojo files are read here rather than at manifest-normalization time, because
  // normalizing is filesystem-free by design and this needs files on disk. What they
  // fill in only matters for cross-realm links, and those are decided at link time.
  const place = await resolvePlace(projectDir, manifest)
  const linked = await link({
    projectDir,
    manifest: { ...manifest, place: place.place },
    resolution,
    sources,
  })

  // Written after linking so that `moduleRoot` records what actually happened rather
  // than what was predicted. Skipped for --production, whose graph is a subset.
  if (!production) {
    await writeLockfile(
      projectDir,
      buildLockfile({
        manifest,
        resolution,
        registry: lockfile?.registry ?? DEFAULT_API_URL,
        integrity: new Map(summary.packages.map((p) => [p.key, p.integrity])),
        moduleRoots: linked.moduleRoots,
      }),
    )
  }

  return {
    manifest,
    // Checked after linking rather than before, because only linking knows which
    // realms actually received anything — warning about an empty realm nobody uses
    // would be noise on every install that has no server dependencies.
    placeNotes: [...place.notes, ...unmountedRealms(place.scan, manifest, linked.usedRealms)],
    placeDuplicates: await hazardsInPlace(projectDir, manifest),
    resolution,
    link: linked,
    cached: summary.cached,
    downloaded: summary.downloaded,
    elapsedMs: performance.now() - started,
    fromLockfile: reuse,
    staleReasons: freshness.reasons,
  }
}

function integrityOf(lockfile: NonNullable<Awaited<ReturnType<typeof readLockfile>>>) {
  return new Map(Object.entries(lockfile.packages).map(([key, p]) => [key, p.integrity]))
}

/**
 * Compatible duplicates only, because install output has to earn every line.
 *
 * `dedupe` reports both kinds; two majors are a fact about the graph that someone
 * asked to see. A compatible duplicate is a defect, it is invisible to every check
 * scoped to one project, and the person who just ran an install is the one who can
 * still do something about it.
 */
async function hazardsInPlace(
  projectDir: string,
  manifest: NormalizedManifest,
): Promise<PlaceReport[]> {
  const scan = await scanPlaces(projectDir, Object.values(realmDirs(manifest.packageDir)))

  return scan.places
    .map((place) => ({ ...place, duplicates: place.duplicates.filter((d) => d.compatible) }))
    .filter((place) => place.duplicates.length > 0)
}
