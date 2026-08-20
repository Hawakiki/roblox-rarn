import { access } from 'node:fs/promises'

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
