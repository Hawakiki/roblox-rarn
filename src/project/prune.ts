import { cp, readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import type { ModuleRoot } from './rojo.ts'
import { findModuleRoot } from './rojo.ts'

export interface PruneResult {
  /** Where the module was written. A file when the module is a single file. */
  readonly destination: string
  readonly root: ModuleRoot
  /** Files in the whole archive, and how many were actually installed. */
  readonly archiveFiles: number
  readonly installedFiles: number
}

/**
 * Copies just the module out of an extracted archive.
 *
 * `destinationBase` is the path without an extension. A directory module lands there
 * as-is; a single-file module gets the source file's extension appended, so
 * `red-blox/signal` becomes `signal.luau` rather than a directory that happens to
 * contain one file. That distinction is not cosmetic — the shim requires
 * `_Index[...].signal`, which has to resolve to a ModuleScript either way.
 */
export async function pruneInto(
  extractedDir: string,
  destinationBase: string,
  subject: string,
): Promise<PruneResult> {
  const root = await findModuleRoot(extractedDir)
  const source = root.path === '' ? extractedDir : join(extractedDir, root.path)

  const destination =
    root.kind === 'file' ? `${destinationBase}${extname(root.path)}` : destinationBase

  try {
    await cp(source, destination, { recursive: root.kind === 'directory', force: true })
  } catch (cause) {
    throw new RarnError({
      code: Code.ModuleRootMissing,
      what: `Could not install ${subject}.`,
      where: destination,
      how: 'Check that the install directory is writable.',
      cause,
    })
  }

  return {
    destination,
    root,
    archiveFiles: await countFiles(extractedDir),
    installedFiles: root.kind === 'file' ? 1 : await countFiles(destination),
  }
}

/**
 * Recursive file count, used only for reporting how much pruning saved.
 *
 * **Two full walks per package, for one line of output — and it stays.** R3 proposed
 * dropping it and priced the pair at 482ms of a 506-package install, which was true of a
 * serial prune loop. Once the loop became concurrent the walks overlap with the copies
 * and with each other, and the same probe measures **109.6ms of 2,847ms (3.8%)** for
 * removing both. Removing only the destination walk — countable from the archive side
 * instead, which would keep the output — is **40.4ms, inside the noise**.
 *
 * That is the trade in full: a few percent against the only place a user sees that
 * pruning happened at all, on a tool whose whole difference from Wally here is that it
 * prunes (constraint 3). Not worth it in either direction.
 *
 * The general lesson is worth more than the number: **a ceiling is only valid against
 * the baseline it was measured on.** This one lost 77% of its value to a change that
 * never touched it.
 */
async function countFiles(path: string): Promise<number> {
  let total = 0
  const stack = [resolve(path)]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue

    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    // A path that vanished mid-count only affects a progress number.
    if (entries === null) continue

    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name))
      else total += 1
    }
  }

  return total
}
