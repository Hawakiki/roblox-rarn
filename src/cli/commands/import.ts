import { readFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { fromWallyToml } from '../../import/wally.ts'
import { findCaseVariant } from '../../linker/ownership.ts'
import { manifestPath } from '../../manifest/read.ts'
import { DEFAULT_PACKAGE_DIR, MANIFEST_FILE_NAME } from '../../manifest/types.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { writeManifest } from '../../manifest/write.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { isNotFoundError, pathExists } from '../../util/fs.ts'
import { writeJson } from '../project.ts'

export const WALLY_MANIFEST_FILE_NAME = 'wally.toml'

export interface ImportOptions {
  cwd: string
  force?: boolean
  dryRun?: boolean
  json?: boolean
}

/**
 * Turns a Wally project into a Rarn one.
 *
 * Named `importWally` because `import` is a reserved word — the command is still
 * `rarn import`.
 */
export async function importWally(options: ImportOptions): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  const source = join(projectDir, WALLY_MANIFEST_FILE_NAME)
  const target = manifestPath(projectDir)

  const text = await readWallyToml(source)
  const result = fromWallyToml(text, source)

  // Said here as well as refused at install time. `import` is the command that
  // chooses `packageDir`, so it is the first moment the collision is knowable — and
  // on Windows and macOS a project with a `packages/` source directory is exactly
  // the shape this writes `Packages` into.
  const packageDir = result.manifest.packageDir ?? DEFAULT_PACKAGE_DIR
  const collision = await findCaseVariant(projectDir, packageDir)
  const warnings =
    collision === undefined
      ? result.warnings
      : [
          ...result.warnings,
          `packageDir is "${packageDir}" but this project already has "${collision}/". On Windows and macOS those are one directory, so installing would replace it — rename one of them first.`,
        ]
  validateManifest(result.manifest, target)

  if (options.force !== true && options.dryRun !== true && (await pathExists(target))) {
    throw new RarnError({
      code: Code.ManifestInvalid,
      what: `${MANIFEST_FILE_NAME} already exists.`,
      where: target,
      how: 'Pass --force to overwrite it, or --dry-run to see what the import would produce.',
    })
  }

  if (options.json === true) {
    writeJson({
      manifest: result.manifest,
      dependencies: result.dependencies,
      warnings,
      written: options.dryRun !== true,
    })
    if (options.dryRun !== true) await writeManifest(projectDir, result.manifest)
    return
  }

  const lines: string[] = [
    `${chalk.bold(result.manifest.name)}@${result.manifest.version}`,
    chalk.dim(`  from ${WALLY_MANIFEST_FILE_NAME}`),
    '',
  ]

  if (result.dependencies.length === 0) {
    lines.push(chalk.dim('  no dependencies'), '')
  } else {
    const width = Math.max(...result.dependencies.map((dep) => dep.name.length))
    for (const dep of result.dependencies) {
      // The requirement is shown before and after whenever the text changed, because
      // the change that matters most is invisible in the result alone: `1.0.0` and
      // `^1.0.0` look equally deliberate once written down.
      const translated =
        dep.cargo === dep.range
          ? chalk.dim(dep.range)
          : `${chalk.dim(dep.cargo)} ${chalk.dim('→')} ${chalk.cyan(dep.range)}`
      const alias = dep.aliasKept ? chalk.dim(`  (alias ${dep.alias})`) : ''
      lines.push(`  ${dep.name.padEnd(width)}  ${translated}${alias}`)
    }
    lines.push('')
  }

  for (const warning of warnings) {
    lines.push(`${chalk.yellow('warning')} ${warning}`)
  }
  if (warnings.length > 0) lines.push('')

  if (options.dryRun === true) {
    lines.push(chalk.dim(`would write ${target}`), '')
    process.stdout.write(lines.join('\n'))
    return
  }

  await writeManifest(projectDir, result.manifest)
  lines.push(
    `${chalk.green('created')} ${MANIFEST_FILE_NAME}`,
    // wally.toml is left alone. It is the file every other tool in the project still
    // reads, and deleting the thing that was just imported is not the importer's call.
    chalk.dim(`  ${WALLY_MANIFEST_FILE_NAME} was left in place`),
    '',
    `Next: ${chalk.cyan('rarn install')}`,
    '',
  )
  process.stdout.write(lines.join('\n'))
}

async function readWallyToml(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if (!isNotFoundError(cause)) throw cause
    throw new RarnError({
      code: Code.WallyManifestMissing,
      what: `There is no ${WALLY_MANIFEST_FILE_NAME} here.`,
      where: path,
      how: `Run this in a Wally project, or use ${chalk.cyan('rarn init')} to start a new one.`,
      cause,
    })
  }
}
