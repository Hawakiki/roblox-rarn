import { relative, resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { type InstallOutcome, runInstall } from '../../install/run.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { WarnCode } from '../../util/codes.ts'
import { outputSettings, verbose } from '../output.ts'
import { createProgress } from '../progress.ts'

export interface InstallOptions {
  cwd: string
  production?: boolean
  silent?: boolean
  /** Refuse to update a stale lockfile instead of rewriting it. For CI. */
  frozenLockfile?: boolean
}

export type { InstallOutcome }

/**
 * Wiring only: run the pipeline, drive the spinner, print the summary.
 *
 * The pipeline itself is `src/install/run.ts`. What is left here is the part that
 * needs a terminal — everything a test would have to fake in order to reach the
 * ordering of stages, which is the part worth testing.
 */
export async function install(
  options: InstallOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<InstallOutcome> {
  const projectDir = resolvePath(options.cwd)
  const progress = createProgress()

  let outcome: InstallOutcome
  try {
    outcome = await runInstall({
      projectDir,
      registry,
      ...(options.production === true ? { production: true } : {}),
      ...(options.frozenLockfile === true ? { frozenLockfile: true } : {}),
      observer: {
        stage: (label) => {
          progress.stage(label)
        },
        fetched: (pkg, done, total) => {
          progress.update(`fetching ${done}/${total}  ${pkg.key}`)
          verbose(`${pkg.fromCache ? 'cached' : 'downloaded'} ${pkg.key}`)
        },
        stale: (reason) => {
          verbose(`stale: ${reason}`)
        },
      },
    })
  } catch (error) {
    // Stopped before the error is rendered, or the message lands on top of a
    // spinner that is still repainting itself and half of it is overwritten.
    progress.fail()
    throw error
  }

  progress.stop()
  if (options.silent !== true && !outputSettings().silent) {
    process.stdout.write(report(outcome, projectDir))
  }
  return outcome
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
