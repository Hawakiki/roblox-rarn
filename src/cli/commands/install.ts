import { relative, resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { fetchPackages } from '../../cache/fetch.ts'
import { createCacheStore } from '../../cache/store.ts'
import { type LinkResult, link } from '../../linker/link.ts'
import { readManifest } from '../../manifest/read.ts'
import type { NormalizedManifest } from '../../manifest/types.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { resolve } from '../../resolver/resolve.ts'
import type { Resolution } from '../../resolver/types.ts'

export interface InstallOptions {
  cwd: string
  production?: boolean
  silent?: boolean
}

export interface InstallOutcome {
  readonly manifest: NormalizedManifest
  readonly resolution: Resolution
  readonly link: LinkResult
  readonly cached: number
  readonly downloaded: number
  readonly elapsedMs: number
}

/**
 * The whole pipeline: read, resolve, fetch, link.
 *
 * No lockfile yet, so every run re-resolves. The archives still come from the global
 * cache, which is where the time actually goes — skipping resolution as well is what
 * the lockfile buys, and that lands in M7.
 */
export async function install(
  options: InstallOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<InstallOutcome> {
  const started = performance.now()
  const projectDir = resolvePath(options.cwd)

  const manifest = await readManifest(projectDir)
  const resolution = await resolve({
    manifest,
    registry,
    ...(options.production === true ? { production: true } : {}),
  })

  const store = createCacheStore()
  const summary = await fetchPackages({ packages: resolution.packages, registry, store })

  const sources = new Map(summary.packages.map((p) => [p.key, p.dir]))
  const linked = await link({ projectDir, manifest, resolution, sources })

  const outcome: InstallOutcome = {
    manifest,
    resolution,
    link: linked,
    cached: summary.cached,
    downloaded: summary.downloaded,
    elapsedMs: performance.now() - started,
  }

  if (options.silent !== true) process.stdout.write(report(outcome, projectDir))
  return outcome
}

/**
 * The install summary.
 *
 * Says how many packages came from cache, because that number is the difference
 * between a slow install and an instant one and is otherwise invisible. Duplicates
 * and applied overrides are reported too — a silently duplicated package is exactly
 * the failure that shows up much later as a broken singleton.
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
  lines.push(
    chalk.dim(
      `  ${outcome.downloaded} downloaded, ${outcome.cached} cached  ${Math.round(outcome.elapsedMs)}ms`,
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
