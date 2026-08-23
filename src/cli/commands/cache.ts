import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import { computeIntegrity } from '../../cache/integrity.ts'
import { cacheRoot } from '../../cache/paths.ts'
import { readLockfile } from '../../lockfile/read.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { pathExists } from '../../util/fs.ts'
import { isInteractive } from '../output.ts'
import { writeJson } from '../project.ts'

export interface CacheOptions {
  cwd: string
  action: 'dir' | 'clean' | 'verify'
  json?: boolean
  /** Skip the confirmation on `clean`. */
  yes?: boolean
}

export async function cache(options: CacheOptions): Promise<void> {
  const root = cacheRoot()

  switch (options.action) {
    case 'dir':
      process.stdout.write(`${root}\n`)
      return
    case 'clean':
      await clean(root, options)
      return
    case 'verify':
      await verify(root, options)
      return
    default:
      throw new RarnError({
        code: Code.InvalidArguments,
        what: `Unknown cache action ${JSON.stringify(String(options.action))}.`,
        how: 'Use one of: dir, clean, verify.',
      })
  }
}

/**
 * Empties the cache, after saying what that costs.
 *
 * Everything here is regenerable, so this is safe in the sense that nothing is lost
 * permanently — but it is not *cheap*: the next install of every project on this
 * machine goes back to the network. Showing the size first is what turns a reflex
 * into a decision.
 */
async function clean(root: string, options: CacheOptions): Promise<void> {
  const usage = await measure(root)

  if (usage.files === 0) {
    process.stdout.write(`${chalk.dim('the cache is already empty')}\n`)
    return
  }

  process.stdout.write(
    [
      chalk.bold(root),
      `  ${usage.packages} packages, ${usage.files} files, ${formatBytes(usage.bytes)}`,
      '',
    ].join('\n'),
  )

  // Nobody is there to answer when stdin is not a terminal. `init` fills in its
  // defaults in that case; here the two directions are not symmetric, so this one
  // refuses instead. Guessing wrong at `init` writes a file the person can edit;
  // guessing wrong here sends every project on the machine back to the network.
  //
  // What it replaces is worth naming: this used to print the question, delete
  // nothing, print nothing else, and exit 0 — the same shape RN-8 had at `init`,
  // in the one other command that asks a question.
  if (options.yes !== true && !isInteractive(process.stdin)) {
    throw new RarnError({
      code: Code.PromptAborted,
      what: 'Nothing was deleted: stdin is not a terminal, so the confirmation could not be asked.',
      how: 'Run `rarn cache clean --yes` to delete it without being asked.',
    })
  }

  if (options.yes !== true && !(await confirm('Delete all of it?'))) {
    process.stdout.write(`${chalk.dim('nothing was deleted')}\n`)
    return
  }

  await rm(root, { recursive: true, force: true })
  process.stdout.write(`${chalk.green('cleaned')} freed ${formatBytes(usage.bytes)}\n`)
}

/**
 * Checks the cache is internally consistent, and against the lockfile when there is one.
 *
 * Two different questions. Without a project, all that can be asked is whether every
 * unpacked tree still has the archive it came from and vice versa — an orphan on
 * either side means an interrupted or hand-edited cache. Inside a project, the
 * lockfile supplies the digests, and *that* is the check worth having: it proves the
 * bytes on disk are the bytes the lockfile pinned.
 */
async function verify(root: string, options: CacheOptions): Promise<void> {
  const downloads = join(root, 'downloads')
  const extracted = join(root, 'extracted')

  const zips = new Set((await listDir(downloads)).map((n) => n.replace(/\.zip$/, '')))
  const trees = new Set(await listDir(extracted))

  const orphanArchives = [...zips].filter((key) => !trees.has(key)).sort()
  const orphanTrees = [...trees].filter((key) => !zips.has(key)).sort()

  const lockfile = await readLockfile(options.cwd).catch(() => undefined)
  const mismatched: string[] = []
  const verified: string[] = []

  if (lockfile !== undefined) {
    for (const [key, locked] of Object.entries(lockfile.packages)) {
      const entry = locked.indexDir ?? ''
      const archive = join(downloads, `${entry}.zip`)
      if (entry === '' || !(await pathExists(archive))) continue

      const bytes = await Bun.file(archive).bytes()
      if (computeIntegrity(bytes) === locked.integrity) verified.push(key)
      else mismatched.push(key)
    }
  }

  // A mismatch means the bytes on disk are not the bytes the lockfile pinned. That is
  // worth an exit code, because it is the one finding here that could be an attack.
  //
  // Set on both paths. `--json` is the form a script reads, and a script reads the
  // exit code rather than the body — reporting the mismatch only in JSON that exits 0
  // is louder to a person and silent to the caller that was built to catch it.
  const failed = mismatched.length > 0

  if (options.json === true) {
    writeJson({ root, orphanArchives, orphanTrees, verified, mismatched })
    if (failed) process.exitCode = 1
    return
  }

  const lines = [chalk.bold(root)]
  lines.push(`  ${zips.size} archives, ${trees.size} unpacked trees`)

  if (lockfile === undefined) {
    lines.push(
      chalk.dim('  no rarn.lock here, so only structure was checked — run inside a project'),
      chalk.dim('  to verify the cached bytes against the digests it records.'),
    )
  } else {
    lines.push(`  ${chalk.green(`${verified.length} verified`)} against rarn.lock`)
  }

  for (const key of orphanArchives) {
    lines.push(`  ${chalk.yellow('archive with no unpacked tree')}  ${key}`)
  }
  for (const key of orphanTrees) {
    lines.push(`  ${chalk.yellow('unpacked tree with no archive')}  ${key}`)
  }
  for (const key of mismatched) {
    lines.push(`  ${chalk.red('digest mismatch')}  ${key}`)
  }

  if (orphanArchives.length + orphanTrees.length + mismatched.length === 0) {
    lines.push(`  ${chalk.green('consistent')}`)
  } else {
    lines.push('', chalk.dim('  `rarn cache clean` discards everything; it is all regenerable.'))
  }

  process.stdout.write(`${lines.join('\n')}\n`)

  if (failed) process.exitCode = 1
}

async function listDir(path: string): Promise<string[]> {
  return await readdir(path).catch(() => [])
}

async function measure(root: string): Promise<{ packages: number; files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (entries === null) continue

    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else {
        files += 1
        bytes += (await stat(path).catch(() => null))?.size ?? 0
      }
    }
  }

  return { packages: (await listDir(join(root, 'extracted'))).length, files, bytes }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  // Ctrl+D closes the input without answering, and a question whose input ended
  // never settles — the event loop drains and the process exits 0 having asked
  // and done nothing. Declining is the right reading of it anyway: the one thing
  // certain about an unanswered destructive question is that nobody said yes.
  const ended = new AbortController()
  rl.once('close', () => {
    ended.abort()
  })

  try {
    const answer = await rl.question(`${question} ${chalk.dim('(y/N)')} `, {
      signal: ended.signal,
    })
    return answer.trim().toLowerCase().startsWith('y')
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return false
    throw error
  } finally {
    rl.close()
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
