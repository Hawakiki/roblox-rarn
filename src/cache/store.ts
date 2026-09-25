import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Code } from '../util/codes.ts'
import { RarnError, RegistryError } from '../util/errors.ts'
import { isNotFoundError, pathExists } from '../util/fs.ts'
import type { PackageName } from '../util/package-name.ts'
import { toWallyName } from '../util/package-name.ts'
import { extractZip } from './archive.ts'
import { assertIntegrityString, computeIntegrity, verifyIntegrity } from './integrity.ts'
import { cacheKey, cacheRoot, downloadPath, extractedPath, tempPath } from './paths.ts'

export interface CachedPackage {
  /** Directory holding the unpacked archive. */
  readonly dir: string
  /** `sha256-…` of the archive bytes. */
  readonly integrity: string
  /** True when nothing had to be downloaded or unpacked. */
  readonly fromCache: boolean
  /**
   * Digest of a cached archive that disagreed with rarn.lock and was replaced once the
   * registry sided with the lockfile. Reported rather than healed in silence: nothing on
   * this machine says how those bytes got there, and the same cache serves every project
   * on it — any other lockfile that pinned this digest is now the one that disagrees.
   */
  readonly discarded?: string | undefined
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

      // First, so a malformed digest is reported as itself rather than read as a cache
      // that disagrees with it.
      if (expectedIntegrity !== undefined) assertIntegrityString(expectedIntegrity, subject)

      // The fast path, and the whole point of the extracted tier: a warm cache does
      // no network and no inflate.
      //
      // **Only the archive is verified; the unpacked tree is trusted as local state.**
      // Both are written from the same bytes in the same call, so the archive vouches
      // for the tree as it was written — but not for anything done to it since.
      // Checking that means reading every file of every package on every warm install:
      // measured on a 620-package cache, 13,141 files took 1.7s against 0.1s for the
      // archives (58s against 3.4s with a cold OS cache), before walking a single
      // directory. Too much to spend guarding a directory that, by default, only this
      // user can write to — so an edit made inside `extracted/` is installed as edited,
      // and `rarn cache clean` is the way back from one.
      let unusable: Unusable | undefined
      if (await pathExists(extracted)) {
        const cached = await digestOf(archive)
        if (cached === undefined) {
          unusable = { kind: 'incomplete' }
        } else if (expectedIntegrity === undefined || cached === expectedIntegrity) {
          return { dir: extracted, integrity: cached, fromCache: true }
        } else {
          unusable = { kind: 'mismatch', cached, expected: expectedIntegrity }
        }
      }

      const bytes =
        unusable === undefined
          ? await fetchArchive()
          : await refetch(fetchArchive, subject, unusable)
      const integrity = computeIntegrity(bytes)

      // Nothing cached is touched until the registry has answered, because only its
      // answer can say the entry is the one that is wrong. rarn.lock can be instead —
      // written, say, on a machine whose cache was damaged — and this cache serves every
      // project here, so an entry removed on one lockfile's word is another project's
      // offline install gone. So: kept when the download fails and when the entry holds
      // the bytes the registry serves; removed when it holds anything else, whether or
      // not this run then succeeds.
      //
      // What it holds is read again here, not taken from before the download. In
      // between, another install may have repaired this same entry and handed the tree
      // to a linker that is copying out of it; acting on the earlier read would pull
      // that tree out from under the copy, and report bytes the other run already did.
      //
      // The archive goes first. The tree has to go for a new one to land, since
      // `renameIntoPlace` keeps a directory it finds, and a removal that stops partway
      // then leaves a tree without an archive — which every reader downloads again —
      // rather than an archive vouching for half a tree.
      //
      // What that leaves open: after a failed repair, a run with no digest to compare
      // still takes the entry at its word, as it always has.
      const held = unusable === undefined ? undefined : await digestOf(archive)
      if (unusable !== undefined && held !== integrity) {
        await rm(archive, { force: true })
        await rm(extracted, { recursive: true, force: true })
      }
      if (expectedIntegrity !== undefined) {
        verifyIntegrity(
          bytes,
          expectedIntegrity,
          subject,
          unusable?.kind === 'mismatch'
            ? cacheVerdict(unusable.cached, unusable.cached === integrity)
            : undefined,
        )
      }

      // Repaired by another install while this one downloaded. Writing again would change
      // nothing — the archive already holds these bytes, and `renameIntoPlace` keeps the
      // tree it finds — so the entry is returned as it stands.
      if (held === integrity && (await pathExists(extracted))) {
        return { dir: extracted, integrity, fromCache: false }
      }

      await writeAtomic(archive, bytes, root, key)
      await extractAtomic(bytes, extracted, root, key, subject)

      return {
        dir: extracted,
        integrity,
        fromCache: false,
        discarded:
          unusable?.kind === 'mismatch' && held === unusable.cached ? unusable.cached : undefined,
      }
    },
  }
}

/**
 * Why a cached entry could not be used.
 *
 * `mismatch` is an archive that disagrees with rarn.lock, with nothing yet to say which
 * of the two is wrong. It is read off the disk here, not served by anyone, so it is not
 * the registry's to answer for until the registry has been asked — which is what the
 * download that follows does.
 */
type Unusable =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'mismatch'; readonly cached: string; readonly expected: string }

/**
 * What the cached copy says about an RN0300, which the digests alone leave open.
 *
 * The registry and rarn.lock disagree; the cache is a third witness. When it sides with
 * the registry, the lockfile is the odd one out — likely written somewhere else — and
 * the reader should look there first. When it sides with neither, it has just been
 * thrown out of a cache other projects read, and that is worth a line too.
 */
function cacheVerdict(cached: string, agrees: boolean): readonly string[] {
  return agrees
    ? [
        "  This machine's cache held these same bytes, so the registry and the cache agree",
        '  and rarn.lock is the one that differs. The cached copy was left in place.',
      ]
    : [
        "  This machine's cache held bytes the registry does not serve either, and they were",
        '  discarded:',
        `    cached:   ${cached}`,
      ]
}

/**
 * Digest of a cached archive, or undefined when there is none.
 *
 * Extracted, but the archive is gone — pruned by hand, or a half-cleaned cache. There
 * is nothing left to hash, and inventing a digest here would write a value into the
 * lockfile that describes no real bytes.
 *
 * One read rather than a check and then a read: `ensure` asks again while another
 * install may be removing this very archive, and a gap between the two would turn
 * that into a raw ENOENT.
 */
async function digestOf(archive: string): Promise<string | undefined> {
  try {
    return computeIntegrity(await readFile(archive))
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

/**
 * Downloads again what the cache could not supply, and says why if that fails.
 *
 * Without the context, what a reader sees is the download's failure alone — under
 * `--offline`, "network access is turned off" on an install that looked fully cached,
 * with nothing to say which package needed the network or why. The code is kept, since
 * it names what actually stopped the repair and is what a script or a search keys on;
 * so is the class, so a transport failure still exits as one.
 */
async function refetch(
  fetchArchive: () => Promise<Uint8Array>,
  subject: string,
  unusable: Unusable,
): Promise<Uint8Array> {
  try {
    return await fetchArchive()
  } catch (error) {
    if (!(error instanceof RarnError)) throw error

    const why =
      unusable.kind === 'mismatch'
        ? [
            "  The copy in this machine's cache was not installed, and was left as it was. Only a",
            '  fresh download can say whether it or rarn.lock is wrong, and none was possible.',
            `    expected: ${unusable.expected}`,
            `    cached:   ${unusable.cached}`,
          ]
        : [
            '  Its unpacked tree was cached without the archive it came from, so there was',
            '  nothing to check it against.',
          ]

    const Wrapped = error instanceof RegistryError ? RegistryError : RarnError
    throw new Wrapped({
      code: error.code,
      what:
        unusable.kind === 'mismatch'
          ? `The cached copy of ${subject} does not match rarn.lock, and it could not be downloaded again.`
          : `The cached copy of ${subject} is incomplete, and it could not be downloaded again.`,
      where: error.where,
      detail: [
        ...why,
        '',
        `  ${error.what}`,
        ...(error.detail === undefined ? [] : [error.detail]),
      ].join('\n'),
      how: error.how,
      cause: error,
    })
  }
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
