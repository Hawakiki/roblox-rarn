import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Placement } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { pathExists } from '../util/fs.ts'
import type { InstallLayout } from './layout.ts'

/** Where a install is assembled before it replaces the previous one. */
export const STAGING_DIR = '.rarn-tmp'

/** Prefix for a previous tree that has been moved aside but not yet deleted. */
export const RETIRED_PREFIX = '.rarn-old-'

const PLACEMENTS: readonly Placement[] = ['shared', 'server', 'dev']

/**
 * Replaces the previous install with the staged one.
 *
 * The previous version of this deleted the realm directories first and rebuilt them
 * in place, so a Ctrl-C — or a package that failed to prune — left the project with
 * half a tree and no way back: the working install was already gone. The cache has
 * solved this since M4 by writing to a temp path and renaming it into place; this is
 * the linker finally holding itself to the same standard.
 *
 * `cache/store.ts` has a function by almost this name that is deliberately *not*
 * reused. There an existing target means another process won a race, so the right
 * move is to keep theirs and drop ours. Here the target is the user's previous
 * install and it must lose — the same code with the opposite meaning.
 *
 * **This is not atomic across the three realms.** Nothing can be: three directories
 * cannot be replaced in one operation. What it does is narrow the window to two
 * renames per realm, on the same filesystem, with all the slow work already done —
 * and, when one of those renames does fail, put the previous tree back rather than
 * leaving the project with neither.
 *
 * **It does not delete the tree it retires.** That is left for `clearRetired`, which the
 * next install starts before building and finishes while the build runs. Deleting here
 * cost 2,049ms of a 6,517ms repeat install of a 506-package graph — 31.4%, measured, and
 * the largest single item on that path after the copy — and every millisecond of it was
 * spent after the user's install was already correct on disk. Nothing overlapped it,
 * because nothing comes after it.
 *
 * The trade is one directory: between installs the project holds the previous tree as
 * well as the current one (43MB at 506 packages). `rarn init` already gitignores the
 * retired prefix, and the safety story only improves — the tree the user had survives
 * longer, not less.
 */
export async function swapIn(
  final: InstallLayout,
  staged: InstallLayout,
  token: string,
): Promise<void> {
  const retiredRoot = join(final.projectDir, `${RETIRED_PREFIX}${token}`)
  const done: { readonly to: string; readonly aside: string | undefined }[] = []

  try {
    for (const placement of PLACEMENTS) {
      const from = staged.realms[placement]
      const to = final.realms[placement]

      // Aside and in, one realm at a time. Moving all three aside first and then
      // moving all three in would leave every realm missing at once, which is the
      // one moment where an interrupted run looks like a successful uninstall.
      let aside: string | undefined
      if (await pathExists(to)) {
        aside = join(retiredRoot, placement)
        await moveAside(to, aside)
      }

      // A realm nothing was placed into is not rebuilt, so retiring it is how a
      // dependency's removal actually reaches the tree.
      if (await pathExists(from)) await rename(from, to)
      done.push({ to, aside })
    }
  } catch (error) {
    await rollBack(done, retiredRoot, error)
    // Reached only when every step was reversed, which leaves this empty.
    await rm(retiredRoot, { recursive: true, force: true })
    throw error
  }
}

async function moveAside(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true })
  await rename(from, to)
}

/**
 * Puts back what was already swapped, in reverse.
 *
 * Best effort by necessity — if a rename just failed, the reverse rename can fail
 * for the same reason (on Windows, a file held open by Studio or a Rojo serve will
 * do it). What must not happen is the user being left with neither tree and no idea
 * where the old one went, so a failed rollback reports the directory it is sitting
 * in rather than swallowing the problem.
 */
async function rollBack(
  done: readonly { readonly to: string; readonly aside: string | undefined }[],
  retiredRoot: string,
  cause: unknown,
): Promise<void> {
  for (const step of [...done].reverse()) {
    try {
      if (await pathExists(step.to)) await rm(step.to, { recursive: true, force: true })
      if (step.aside !== undefined) await rename(step.aside, step.to)
    } catch {
      throw new RarnError({
        code: Code.InstallSwapFailed,
        what: 'The install could not be completed, and the previous one could not be put back.',
        where: step.to,
        detail: `  The previous tree is in ${retiredRoot}.`,
        how: 'Close anything holding those files open — Studio, a Rojo serve — then move that directory back by hand. Nothing was lost.',
        cause,
      })
    }
  }
}

/**
 * Clears the staging directory a previous run left behind.
 *
 * Run before staging rather than only after a failure, because the run that leaves this
 * behind is by definition the one that did not get to clean up.
 *
 * **Kept separate from `clearRetired`, and awaited where that one is not.** The staging
 * directory is an input to the build — the build writes into it — so removing it has to
 * finish first. A retired tree is an input to nothing.
 */
export async function clearStaging(projectDir: string): Promise<void> {
  await rm(join(projectDir, STAGING_DIR), { recursive: true, force: true })
}

/**
 * Deletes every previous install tree that has been moved aside and not yet removed.
 *
 * Started before the build and awaited after it, so this runs *while* the new tree is
 * being copied out of the cache rather than after it. That overlap is the whole point:
 * the work is the same either way, and on a repeat install of a 506-package graph it is
 * 2,049ms that used to be the last thing between a correct tree on disk and the shell
 * prompt coming back.
 *
 * Two things make the overlap safe. The `readdir` happens once, at the start, so the
 * tree `swapIn` retires later is not in the list and cannot be deleted out from under a
 * rollback. And nothing else reads or writes these paths — `.rarn-old-*` is not a realm
 * directory, not the staging directory, and `place.ts` skips dot-directories when it
 * looks for project files.
 *
 * **Failures are swallowed on purpose.** On Windows a file held open by Studio or a Rojo
 * serve refuses deletion, and this used to throw before any work started, which was
 * defensible when a retired tree meant an interrupted run. Now one exists after every
 * install, so throwing here would fail installs that are entirely correct because of
 * garbage nobody is waiting on. The next run tries again — that has always been the
 * safety net, and it is what makes swallowing the right answer rather than a shrug.
 */
export async function clearRetired(projectDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.startsWith(RETIRED_PREFIX)) continue
    await rm(join(projectDir, entry), { recursive: true, force: true }).catch(() => undefined)
  }
}
