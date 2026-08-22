import { relative, resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { fetchPackages } from '../../cache/fetch.ts'
import { createCacheStore } from '../../cache/store.ts'
import { type PlaceReport, scanPlaces } from '../../doctor/places.ts'
import { type LinkResult, link } from '../../linker/link.ts'
import { checkFreshness } from '../../lockfile/freshness.ts'
import { readLockfile, resolutionFromLockfile } from '../../lockfile/read.ts'
import { LOCKFILE_NAME } from '../../lockfile/types.ts'
import { buildLockfile, writeLockfile } from '../../lockfile/write.ts'
import { readManifest } from '../../manifest/read.ts'
import type { NormalizedManifest } from '../../manifest/types.ts'
import { realmDirs } from '../../manifest/types.ts'
import { resolvePlace, unmountedRealms } from '../../project/place.ts'
import { createRegistryClient } from '../../registry/client.ts'
import { DEFAULT_API_URL } from '../../registry/types.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { resolve } from '../../resolver/resolve.ts'
import type { Resolution } from '../../resolver/types.ts'
import { Code, WarnCode } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { outputSettings, verbose } from '../output.ts'
import { createProgress } from '../progress.ts'

export interface InstallOptions {
  cwd: string
  production?: boolean
  silent?: boolean
  /** Refuse to update a stale lockfile instead of rewriting it. For CI. */
  frozenLockfile?: boolean
}

export interface InstallOutcome {
  readonly manifest: NormalizedManifest
  /** Disagreements between rarn.json and default.project.json. Always worth printing. */
  readonly placeNotes: readonly string[]
  /**
   * Compatible duplicates this install's packages share a DataModel with.
   *
   * Only the compatible ones, and only on install: two majors are two packages and
   * belong in the report someone asked for, but a compatible duplicate is a defect
   * that no per-project check can see, so it goes where it will actually be read.
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

/**
 * The whole pipeline: read, resolve (or reuse the lockfile), fetch, link.
 *
 * Resolution is the only stage that needs the network — fetching reads the global
 * cache and linking is entirely local. So reusing the lockfile is what turns a
 * repeat install into an offline one, and it is worth the care that decision takes.
 */
export async function install(
  options: InstallOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<InstallOutcome> {
  const started = performance.now()
  const projectDir = resolvePath(options.cwd)
  const progress = createProgress()

  try {
    return await run(options, registry, projectDir, started, progress)
  } catch (error) {
    // Stopped before the error is rendered, or the message lands on top of a
    // spinner that is still repainting itself and half of it is overwritten.
    progress.fail()
    throw error
  }
}

async function run(
  options: InstallOptions,
  registry: RegistryClient,
  projectDir: string,
  started: number,
  progress: ReturnType<typeof createProgress>,
): Promise<InstallOutcome> {
  const manifest = await readManifest(projectDir)
  const lockfile = await readLockfile(projectDir)

  const freshness =
    lockfile === undefined
      ? { fresh: false, reasons: [`no ${LOCKFILE_NAME} yet`] }
      : checkFreshness(lockfile, manifest)

  // `--production` drops devDependencies from the graph, so the result no longer
  // describes the manifest and must not be written back over the lockfile.
  const production = options.production === true

  if (options.frozenLockfile === true && !freshness.fresh) {
    throw new RarnError({
      code: Code.LockfileStale,
      what: `${LOCKFILE_NAME} does not match rarn.json.`,
      where: LOCKFILE_NAME,
      detail: freshness.reasons.map((reason) => `  ${reason}`).join('\n'),
      how: 'Run `rarn install` without --frozen-lockfile and commit the updated lockfile.',
    })
  }

  const reuse = freshness.fresh && lockfile !== undefined && !production
  for (const reason of freshness.reasons) verbose(`stale: ${reason}`)

  let resolution: Resolution
  if (reuse) {
    resolution = resolutionFromLockfile(lockfile)
  } else {
    progress.stage('resolving dependencies')
    resolution = await resolve({ manifest, registry, ...(production ? { production: true } : {}) })
  }

  const store = createCacheStore()
  const total = resolution.packages.size
  progress.stage(`fetching ${total} packages`)
  const summary = await fetchPackages({
    packages: resolution.packages,
    registry,
    store,
    ...(reuse ? { expectedIntegrity: integrityOf(lockfile) } : {}),
    onProgress: (pkg, done) => {
      progress.update(`fetching ${done}/${total}  ${pkg.key}`)
      verbose(`${pkg.fromCache ? 'cached' : 'downloaded'} ${pkg.key}`)
    },
  })

  progress.stage('linking')
  const sources = new Map(summary.packages.map((p) => [p.key, p.dir]))

  // The Rojo file is read here rather than at manifest-normalization time, because
  // normalizing is filesystem-free by design and this needs a file on disk. What it
  // fills in only matters for cross-realm links, and those are decided at link time.
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

  const outcome: InstallOutcome = {
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

  progress.stop()
  if (options.silent !== true && !outputSettings().silent) {
    process.stdout.write(report(outcome, projectDir))
  }
  return outcome
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

function integrityOf(lockfile: NonNullable<Awaited<ReturnType<typeof readLockfile>>>) {
  return new Map(Object.entries(lockfile.packages).map(([key, p]) => [key, p.integrity]))
}

/**
 * The install summary.
 *
 * Reports what came from cache and whether the lockfile was reused, because those
 * two numbers explain the whole difference between a slow install and an instant
 * one and are otherwise invisible. Duplicates and applied overrides are called out
 * too — a silently duplicated package is exactly the failure that surfaces much
 * later as a broken singleton.
 */
function report(outcome: InstallOutcome, projectDir: string): string {
  const { resolution, link: linked } = outcome
  const lines: string[] = []

  if (resolution.packages.size === 0) {
    return `${chalk.dim('nothing to install')}\n`
  }

  const where = linked.usedRealms
    .map((realm) => relative(projectDir, linked.layout.realms[realm]))
    .sort()
    .join(', ')

  lines.push(
    `${chalk.green('installed')} ${resolution.packages.size} packages into ${chalk.cyan(where)}`,
  )

  const pruned = linked.archiveFiles - linked.installedFiles
  const prunedNote = pruned > 0 ? `, ${pruned} pruned` : ''
  lines.push(chalk.dim(`  ${linked.installedFiles} files, ${linked.shims} links${prunedNote}`))

  const source = outcome.fromLockfile ? 'lockfile' : 'resolved'
  lines.push(
    chalk.dim(
      `  ${outcome.downloaded} downloaded, ${outcome.cached} cached, ${source}  ${Math.round(outcome.elapsedMs)}ms`,
    ),
  )

  for (const [name, version] of resolution.overrides) {
    lines.push(`${chalk.yellow('override')} ${name} pinned to ${version} by "resolutions"`)
  }

  for (const [name, versions] of resolution.duplicates) {
    lines.push(
      `${chalk.yellow('duplicate')} ${name} installed at ${versions.join(' and ')}`,
      chalk.dim('  these are separate modules at runtime; run `rarn why` to see who asked'),
    )
  }

  for (const place of outcome.placeDuplicates) {
    const names = place.duplicates.map((d) => d.name).join(', ')
    const verb = place.duplicates.length === 1 ? 'is' : 'are'
    lines.push(
      `${chalk.yellow(WarnCode.CrossTreeDuplicate)} ${names} ${verb} installed twice in the DataModel ${place.project} builds.`,
      chalk.dim('  Two copies are two ModuleScript instances, each with its own state.'),
      chalk.dim('  Run `rarn dedupe` for the versions and which tree each came from.'),
    )
  }

  // Not dimmed like the notes below it. Every one of these means two files disagree
  // about where a directory lives, and the runtime's answer when it matters is
  // "Requested module experienced an error while loading" — measured in Studio, with
  // no path and no missing name in it.
  for (const note of outcome.placeNotes) {
    lines.push(`${chalk.yellow('place')} ${note}`)
  }

  for (const [key, note] of linked.notes) {
    lines.push(chalk.dim(`note ${key}: ${note}`))
  }

  return `${lines.join('\n')}\n`
}
