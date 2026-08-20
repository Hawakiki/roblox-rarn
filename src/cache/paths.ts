import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackageName } from '../util/package-name.ts'
import { toIndexDir } from '../util/package-name.ts'

/**
 * Where the global cache lives.
 *
 * Windows gets `%LOCALAPPDATA%` rather than `%APPDATA%` on purpose: roaming profiles
 * sync `%APPDATA%` between machines, and a package cache is regenerable data that has
 * no business being copied over a network. Everywhere else follows XDG.
 *
 * `RARN_CACHE_DIR` overrides both, which is what the tests use — they must never
 * touch the developer's real cache.
 */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RARN_CACHE_DIR
  if (override !== undefined && override !== '') return override

  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (local !== undefined && local !== '') return join(local, 'rarn', 'cache')
    return join(homedir(), 'AppData', 'Local', 'rarn', 'cache')
  }

  const xdg = env.XDG_CACHE_HOME
  if (xdg !== undefined && xdg !== '') return join(xdg, 'rarn')
  return join(homedir(), '.cache', 'rarn')
}

/**
 * Cache key for a package version.
 *
 * Registry packages are immutable, so the version alone identifies the bytes — no
 * hash needed in the key. Shares the `_Index` folder spelling so a cache entry and
 * an installed folder are recognisably the same thing.
 */
export function cacheKey(name: PackageName, version: string): string {
  return toIndexDir(name, version)
}

/** Raw archive as downloaded. */
export function downloadPath(root: string, key: string): string {
  return join(root, 'downloads', `${key}.zip`)
}

/**
 * Unpacked tree.
 *
 * Caching at this level, not just the archive, is what makes a warm reinstall do no
 * network *and* no unzip. Copying the resulting files into a project is cheap; the
 * download and the inflate are the parts worth never repeating.
 */
export function extractedPath(root: string, key: string): string {
  return join(root, 'extracted', key)
}

/**
 * A scratch path that is renamed into place once fully written.
 *
 * Kept inside the cache root rather than the OS temp dir so the final rename stays on
 * one filesystem — a cross-device rename is not atomic and would silently degrade
 * into a copy that can be observed half-finished.
 */
export function tempPath(root: string, key: string, token: string): string {
  return join(root, '.tmp', `${key}.${token}`)
}

/** Only used when a caller has no cache root at all. */
export function fallbackTempRoot(): string {
  return join(tmpdir(), 'rarn')
}
