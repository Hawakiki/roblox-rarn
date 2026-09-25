import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * The suffix of a file this module has not finished writing.
 *
 * One is left behind when nothing gets to clean up — a hard kill anywhere from its
 * creation to the rename — or when the cleanup is refused too, which on Windows is
 * whatever still holds it open. `publish` excludes the suffix by name, since the file
 * holds a copy of `rarn.json` or `rarn.lock` that nobody meant to ship. It ends in
 * something no tool recognises on purpose: Rojo turns a `.json` into a ModuleScript, and
 * the project-file scan reads anything ending in `.project.json`.
 */
export const ATOMIC_TEMP_SUFFIX = '.rarn-tmp'

/**
 * How long a rename onto the target keeps retrying when Windows says the file is in use.
 *
 * Windows refuses to replace a file that anything holds open, and a reader counts: an
 * editor reloading it, an indexer, `git status`. Writing in place never met this, so
 * without a retry the switch to rename would turn a moment's contention into a failed
 * `rarn add`. Measured against a process reading the file in a tight loop — harsher than
 * any editor — 1,395 of 2,000 first attempts failed with EPERM; with this retry 3,000
 * writes in a row got through, p99 220ms, max 562ms.
 *
 * A holder that keeps the file past the window now fails the write, where writing in
 * place went through unless the holder barred other writers. Measured with a second
 * process holding `rarn.lock` open for 3s: sharing write access, as Node and Bun open a
 * file, the in-place write succeeded at once and this one gave up with EPERM after a
 * second; sharing reading alone, both failed. That is the price of never leaving a torn
 * file — the target stays whole, and the error says to close whatever holds it.
 */
const RENAME_PATIENCE_MS = 1_000

/**
 * Replaces a file's content whole or not at all.
 *
 * Written in place, the target is truncated before the first byte lands, so an
 * interruption or a full disk leaves it cut off mid-object — measured, 35 of 100 random
 * kills of a process rewriting a 20-dependency `rarn.json` in a loop left it
 * unparseable, and a write that runs out of space fails only after truncating. Here the
 * content goes to a temp file beside the target and is renamed over it, which either
 * happens or does not. Any failure before that rename leaves the target exactly as it
 * was, and the temp file is removed on the way out.
 *
 * Three properties of the in-place write are kept deliberately, because renaming would
 * otherwise lose each of them without a sound:
 *
 * - **A symlink is followed**, including one whose target does not exist yet. Renaming
 *   onto the link replaces the link itself with a regular file and leaves the file it
 *   pointed at stale, or never created.
 * - **A read-only file is refused.** A rename needs permission on the directory, not the
 *   file, so on POSIX it would replace one that writing in place could not open.
 * - **The permission bits survive.** The temp file is created fresh, so it would
 *   otherwise take the umask's idea of them instead of the file's.
 *
 * What a new file cannot inherit is knowingly not kept. Measured: another hard link to
 * the file goes on holding the old content, and Windows attributes such as Hidden are
 * dropped. By how rename works rather than by measurement: on POSIX the file comes to
 * belong to whoever ran the write — under `sudo`, root — and a file bind-mounted on its
 * own refuses the rename with EBUSY.
 *
 * Not fsynced, like the cache and the linker. The rename alone covers the process
 * stopping and the write failing, which is what this is for; surviving power loss is a
 * different promise that Rarn makes for no file yet. Cost is not the obstacle — about
 * 0.5ms a write, measured — so it is a decision to take for every writer at once.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const target = await followLinks(path)
  const previous = await stat(target).catch(() => undefined)
  if (previous !== undefined) await access(target, constants.W_OK)

  const mode = previous === undefined ? undefined : previous.mode & 0o7777
  const temp = join(
    dirname(target),
    `.${basename(target)}.${randomUUID().slice(0, 8)}${ATOMIC_TEMP_SUFFIX}`,
  )

  try {
    await writeFile(temp, data, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
    // The mode passed at creation is filtered through the umask; this puts back the
    // bits it took. Best effort: a filesystem that refuses chmod has no bits to keep.
    if (mode !== undefined) await chmod(temp, mode).catch(() => undefined)
    await renameOver(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * `realpath` resolves a link only when what it names exists, and the first write through
 * a link to a file nobody has created yet is exactly when it does not. Writing in place
 * created that file and kept the link, so a dangling one is read by hand.
 */
async function followLinks(path: string): Promise<string> {
  let current = path
  for (let hops = 0; hops < 40; hops++) {
    const real = await realpath(current).catch(() => undefined)
    if (real !== undefined) return real
    const link = await lstat(current).catch(() => undefined)
    if (link === undefined || !link.isSymbolicLink()) return current
    current = resolve(dirname(current), await readlink(current))
  }
  // A cycle never resolves. Stopping where Linux does and asking once more hands back
  // the error writing in place would have met, rather than renaming over a link in it.
  return await realpath(path)
}

async function renameOver(temp: string, target: string): Promise<void> {
  const started = performance.now()
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      const elapsed = performance.now() - started
      if (!isInUseOnWindows(error) || elapsed >= RENAME_PATIENCE_MS) throw error
      await sleep(Math.min(attempt * 5, 50))
    }
  }
}

/**
 * Only on Windows do these mean "someone else has it open". Elsewhere a rename onto a
 * file does not care who is reading it, so the same codes are a real permission problem
 * and waiting a second would only delay the message.
 */
function isInUseOnWindows(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const { code } = error
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}
