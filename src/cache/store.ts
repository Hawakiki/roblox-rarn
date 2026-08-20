import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { pathExists } from '../util/fs.ts'
import type { PackageName } from '../util/package-name.ts'
import { toWallyName } from '../util/package-name.ts'
import { extractZip } from './archive.ts'
import { computeIntegrity, verifyIntegrity } from './integrity.ts'
import { cacheKey, cacheRoot, downloadPath, extractedPath, tempPath } from './paths.ts'

export interface CachedPackage {
  /** Directory holding the unpacked archive. */
  readonly dir: string
  /** `sha256-…` of the archive bytes. */
  readonly integrity: string
  /** True when nothing had to be downloaded or unpacked. */
  readonly fromCache: boolean
}

export interface CacheStore {
  /** Unpacked tree for a version, downloading only if it is not already cached. */
  ensure(
    name: PackageName,
    version: string,
    fetchArchive: () => Promise<Uint8Array>,
    expectedIntegrity?: string,
  ): Promise<CachedPackage>
  /** Where the cache lives, for reporting. */
  readonly root: string
}

export function createCacheStore(root: string = cacheRoot()): CacheStore {
  return {
    root,

    async ensure(name, version, fetchArchive, expectedIntegrity): Promise<CachedPackage> {
      const key = cacheKey(name, version)
      const subject = `${toWallyName(name)}@${version}`
      const extracted = extractedPath(root, key)
      const archive = downloadPath(root, key)

      // The fast path, and the whole point of the extracted tier: a warm cache does
      // no network and no inflate. Integrity is still checked when the lockfile
      // records one, so a tampered cache cannot slip through unnoticed.
      if (await pathExists(extracted)) {
        const cachedIntegrity = await readCachedIntegrity(archive, expectedIntegrity, subject)
        if (cachedIntegrity !== undefined) {
          return { dir: extracted, integrity: cachedIntegrity, fromCache: true }
        }
        // Integrity could not be confirmed from cache; fall through and refetch.
        await rm(extracted, { recursive: true, force: true })
      }

      const bytes = await fetchArchive()
      const integrity = computeIntegrity(bytes)
      if (expectedIntegrity !== undefined) verifyIntegrity(bytes, expectedIntegrity, subject)

      await writeAtomic(archive, bytes, root, key)
      await extractAtomic(bytes, extracted, root, key, subject)

      return { dir: extracted, integrity, fromCache: false }
    },
  }
}

/**
 * Integrity of an already-cached entry.
 *
 * Returns undefined when it cannot be established — the archive was pruned, or its
 * bytes no longer match — which tells the caller to refetch rather than trust what is
 * on disk. Only the archive is hashed; hashing the unpacked tree would need a stable
 * directory digest and would not add anything, since the tree is derived from it.
 */
async function readCachedIntegrity(
  archive: string,
  expected: string | undefined,
  subject: string,
): Promise<string | undefined> {
  // Extracted, but the archive is gone — pruned by hand, or a half-cleaned cache.
  // There is nothing left to hash, and inventing a digest here would write a value
  // into the lockfile that describes no real bytes. Refetch instead.
  if (!(await pathExists(archive))) return undefined

  const bytes = await readFile(archive)
  if (expected !== undefined) verifyIntegrity(bytes, expected, subject)
  return computeIntegrity(bytes)
}

/** Writes a file by writing a temp file and renaming it into place. */
async function writeAtomic(
  target: string,
  bytes: Uint8Array,
  root: string,
  key: string,
): Promise<void> {
  const temp = tempPath(root, `${key}.zip`, randomUUID())
  await mkdir(dirname(temp), { recursive: true })
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temp, bytes)
  await renameIntoPlace(temp, target, false)
}

/** Unpacks into a temp directory and renames it into place once complete. */
async function extractAtomic(
  bytes: Uint8Array,
  target: string,
  root: string,
  key: string,
  subject: string,
): Promise<void> {
  const temp = tempPath(root, key, randomUUID())
  await mkdir(temp, { recursive: true })

  try {
    await extractZip(bytes, temp, subject)
    await mkdir(dirname(target), { recursive: true })
    await renameIntoPlace(temp, target, true)
  } finally {
    // Harmless if the rename already consumed it.
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * Renames a finished temp path onto its final location.
 *
 * A rename cannot land half-done, so a reader never sees a partially written archive
 * or a tree missing files — an interrupted install leaves stale temp entries rather
 * than a cache that looks complete and is not.
 *
 * **Windows will not rename onto an existing path**, unlike POSIX where it replaces
 * silently. An existing target means another process finished the same work first,
 * which is a race worth winning gracefully: keep theirs and drop ours.
 */
async function renameIntoPlace(temp: string, target: string, isDir: boolean): Promise<void> {
  try {
    await rename(temp, target)
  } catch (error) {
    if (await pathExists(target)) {
      await rm(temp, { recursive: isDir, force: true })
      return
    }
    throw new RarnError({
      code: Code.CacheUnwritable,
      what: 'Could not write to the package cache.',
      where: target,
      how: 'Check that the cache directory is writable, or set RARN_CACHE_DIR to somewhere else.',
      cause: error,
    })
  }
}
