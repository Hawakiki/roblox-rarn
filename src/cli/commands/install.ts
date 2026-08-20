import { relative, resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { fetchPackages } from '../../cache/fetch.ts'
import { createCacheStore } from '../../cache/store.ts'
import { type LinkResult, link } from '../../linker/link.ts'
import { checkFreshness } from '../../lockfile/freshness.ts'
import { readLockfile, resolutionFromLockfile } from '../../lockfile/read.ts'
import { LOCKFILE_NAME } from '../../lockfile/types.ts'
import { buildLockfile, writeLockfile } from '../../lockfile/write.ts'
import { readManifest } from '../../manifest/read.ts'
import type { NormalizedManifest } from '../../manifest/types.ts'
import { createRegistryClient } from '../../registry/client.ts'
import { DEFAULT_API_URL } from '../../registry/types.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { resolve } from '../../resolver/resolve.ts'
import type { Resolution } from '../../resolver/types.ts'
import { Code } from '../../util/codes.ts'
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
  const linked = await link({ projectDir, manifest, resolution, sources })

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

  for (const [key, note] of linked.notes) {
    lines.push(chalk.dim(`note ${key}: ${note}`))
  }

  return `${lines.join('\n')}\n`
}
