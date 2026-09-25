import { writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { readManifest } from '../../manifest/read.ts'
import {
  MAX_ARCHIVE_BYTES,
  type PackResult,
  pack as buildArchive,
  kib,
} from '../../publish/pack.ts'
import { renderWallyToml } from '../../publish/wally-toml.ts'
import { writeJson } from '../project.ts'

export interface PackOptions {
  cwd: string
  list?: boolean
  out?: string
  json?: boolean
}

/**
 * Builds the archive and reports what is in it.
 *
 * `--list` exists because publishing cannot be undone. Seeing the file list before
 * the upload is the only chance to notice that a `.env`, a place file, or an entire
 * `docs/` tree is about to become permanently public.
 */
export async function pack(options: PackOptions): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  const manifest = await readManifest(projectDir)
  const result = await buildArchive(projectDir, manifest)

  if (options.json === true) {
    writeJson({
      name: manifest.name,
      version: manifest.version,
      bytes: result.totalBytes,
      files: result.entries.map((e) => ({ path: e.path, bytes: e.bytes })),
      wallyToml: renderWallyToml(manifest),
    })
    return
  }

  const lines: string[] = []

  if (options.list === true) {
    lines.push(chalk.bold(`${manifest.name}@${manifest.version}`), '')
    const width = Math.max(...result.entries.map((e) => kib(e.bytes).length))
    for (const entry of result.entries) {
      const generated = entry.path === 'wally.toml' ? chalk.dim('  (generated)') : ''
      lines.push(`  ${chalk.dim(kib(entry.bytes).padStart(width))}  ${entry.path}${generated}`)
    }
    lines.push('')
  }

  if (options.out !== undefined) {
    const target = resolvePath(projectDir, options.out)
    await writeFile(target, result.archive)
    lines.push(`${chalk.green('wrote')} ${target}`)
  }

  lines.push(...tokenFileLines(result))

  const share = Math.round((result.totalBytes / MAX_ARCHIVE_BYTES) * 100)
  lines.push(
    `${chalk.green('packed')} ${result.entries.length} files, ${kib(result.totalBytes)} ${chalk.dim(`(${share}% of the ${kib(MAX_ARCHIVE_BYTES)} limit)`)}`,
  )

  if (options.list !== true) {
    lines.push(chalk.dim('  `rarn pack --list` shows exactly which files these are'))
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Names the files left out for being the login token file.
 *
 * Leaving it out keeps the token out of the archive and does nothing about the file
 * itself, which still sits in the project where version control has no reason to
 * skip it. Saying so is how the person who put it there finds out.
 */
export function tokenFileLines(result: PackResult): string[] {
  return result.tokenFiles.map(
    (file) =>
      `${chalk.yellow('left out')} ${file} ${chalk.dim('— it holds your login token: move it out of the project, where git can pick it up')}`,
  )
}
