import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { readManifest } from '../../manifest/read.ts'
import { requireToken } from '../../publish/auth.ts'
import { kib, pack } from '../../publish/pack.ts'
import { renderWallyToml } from '../../publish/wally-toml.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { createProgress } from '../progress.ts'
import { tokenFileLines } from './pack.ts'

export interface PublishOptions {
  cwd: string
  dryRun?: boolean
}

/**
 * Uploads the package to the registry.
 *
 * The order of the checks below is the point of this function. Everything that can
 * be known locally is checked before the token is even read, so a bad manifest
 * fails without a network call, and the irreversible step is the last thing that
 * happens rather than something reached halfway through validation.
 */
export async function publish(
  options: PublishOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  const manifest = await readManifest(projectDir)

  // Checked first and by itself. `private` is the one flag whose entire purpose is
  // to prevent this command from running, so it must not be reachable past any
  // other failure that a user might be tempted to work around.
  if (manifest.private) {
    throw new RarnError({
      code: Code.PrivatePackage,
      what: `${manifest.name} is marked private.`,
      where: 'rarn.json',
      how: 'Remove `"private": true` from rarn.json to publish it.',
    })
  }

  const wally = toWallyName(parsePackageName(manifest.name))

  // Building the archive also renders wally.toml, which is where an unpublishable
  // range is caught — before anything is sent, and before a token is read.
  const result = await pack(projectDir, manifest)

  if (options.dryRun === true) {
    process.stdout.write(
      [
        `${chalk.yellow('dry run')} nothing was uploaded`,
        '',
        `  ${chalk.bold(`${wally}@${manifest.version}`)}`,
        `  ${result.entries.length} files, ${kib(result.totalBytes)}`,
        '',
        ...tokenFileLines(result),
        chalk.dim(indent(renderWallyToml(manifest))),
        chalk.dim('  `rarn pack --list` shows the file list'),
        '',
      ].join('\n'),
    )
    return
  }

  const apiUrl = await registry.apiBase()
  const token = await requireToken(apiUrl)

  const progress = createProgress()
  progress.stage(`publishing ${wally}@${manifest.version}`)
  try {
    await registry.publish(result.archive, token, `@${wally}@${manifest.version}`)
    progress.stop()
  } catch (error) {
    progress.fail()
    throw error
  }

  process.stdout.write(
    [
      `${chalk.green('published')} ${chalk.bold(`${wally}@${manifest.version}`)} to ${chalk.cyan(apiUrl)}`,
      chalk.dim(`  ${result.entries.length} files, ${kib(result.totalBytes)}`),
      // Said plainly and only after it has happened. The registry treats versions as
      // immutable, so there is no unpublish to point the reader at.
      chalk.dim('  this version is now permanent — publish a new version to change it'),
      ...tokenFileLines(result),
      '',
    ].join('\n'),
  )
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `  │ ${line}`)
    .join('\n')
}
