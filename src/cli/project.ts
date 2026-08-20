import { resolve as resolvePath } from 'node:path'
import { readLockfile, resolutionFromLockfile } from '../lockfile/read.ts'
import { LOCKFILE_NAME } from '../lockfile/types.ts'
import type { Lockfile } from '../lockfile/types.ts'
import { readManifest } from '../manifest/read.ts'
import type { NormalizedManifest } from '../manifest/types.ts'
import type { Resolution } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'

export interface InstalledProject {
  readonly projectDir: string
  readonly manifest: NormalizedManifest
  readonly lockfile: Lockfile
  /** The lockfile's graph, rebuilt. No registry access. */
  readonly resolution: Resolution
}

/**
 * Loads a project that has already been installed.
 *
 * The read-only commands — `list`, `why`, `dedupe`, `doctor` — all answer questions
 * about what *is* installed, which the lockfile already records in full. Reading it
 * rather than re-resolving keeps them instant and, more importantly, honest: they
 * describe the tree on disk instead of the tree a fresh resolution would produce.
 */
export async function loadInstalled(cwd: string): Promise<InstalledProject> {
  const projectDir = resolvePath(cwd)
  const manifest = await readManifest(projectDir)
  const lockfile = await readLockfile(projectDir)

  if (lockfile === undefined) {
    throw new RarnError({
      code: Code.LockfileStale,
      what: `There is no ${LOCKFILE_NAME} to read.`,
      where: projectDir,
      how: 'Run `rarn install` first — this command reports on what is installed.',
    })
  }

  return { projectDir, manifest, lockfile, resolution: resolutionFromLockfile(lockfile) }
}

/** Tree-drawing prefixes for one level of nesting. */
export function branch(isLast: boolean): { head: string; body: string } {
  return isLast ? { head: '└─ ', body: '   ' } : { head: '├─ ', body: '│  ' }
}

/** Emits JSON exactly as the other commands emit text: one write, trailing newline. */
export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
