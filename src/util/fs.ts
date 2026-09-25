import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { byCodeUnit } from './order.ts'

/**
 * Whether a rejected filesystem call means "not there" rather than a real failure.
 *
 * Worth a named helper because the distinction decides the error the user sees: a
 * missing manifest should suggest `rarn init`, while a permissions failure should
 * not, and collapsing the two produces advice that cannot work.
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const { code } = error
  return code === 'ENOENT'
}

/** Whether a path exists. Never throws. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every file under a directory, absolute, depth-first.
 *
 * Symbolic links are not followed. A link pointing at a parent directory turns the
 * walk into an infinite one, and a link pointing outside the project would pull
 * files into a published archive that the author never meant to ship.
 */
export async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.push(full)
    }
  }

  await walk(root)
  return found
}
