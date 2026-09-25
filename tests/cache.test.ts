import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { extractZip, isZip } from '../src/cache/archive.ts'
import { computeIntegrity, verifyIntegrity } from '../src/cache/integrity.ts'
import { cacheKey, cacheRoot, downloadPath, extractedPath } from '../src/cache/paths.ts'
import { createCacheStore } from '../src/cache/store.ts'
import { exitCodeFor } from '../src/cli/render.ts'
import { Code } from '../src/util/codes.ts'
import { mapWithConcurrency } from '../src/util/concurrency.ts'
import { ExitCode, RarnError, RegistryError } from '../src/util/errors.ts'
import { pathExists } from '../src/util/fs.ts'
import { networkBlockedError } from '../src/util/network.ts'
import { parseWallyName } from '../src/util/package-name.ts'

const promise = parseWallyName('evaera/promise')

/**
 * A real ZIP, so extraction is exercised rather than mocked.
 *
 * The timestamp is fixed for the same reason `pack` fixes it: without it `zipSync`
 * stamps the current time, so building the same input twice produces different
 * bytes and therefore a different digest. Several tests here compare the digest the
 * store recorded against a freshly built archive, and those only disagree when the
 * two calls land either side of a DOS timestamp tick — which is to say they pass
 * locally, pass in review, and fail on a CI runner one time in however many.
 * It took exactly one Windows run to find.
 *
 * 1980-01-01 rather than 0, since a DOS date cannot encode anything earlier.
 */
const ZIP_EPOCH = Date.UTC(1980, 0, 1)

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, body] of Object.entries(files)) {
    entries[path] = new TextEncoder().encode(body)
  }
  return zipSync(entries, { mtime: ZIP_EPOCH })
}

async function expectRejection(fn: () => Promise<unknown>): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the call succeeded')
}

describe('cacheRoot', () => {
  test('RARN_CACHE_DIR wins, so tests never touch the real cache', () => {
    expect(cacheRoot({ RARN_CACHE_DIR: '/custom' })).toBe('/custom')
  })

  // Roaming profiles sync %APPDATA% between machines; a regenerable cache should
  // not be copied over a network.
  test('uses LOCALAPPDATA on Windows, not APPDATA', () => {
    if (process.platform !== 'win32') return
    const root = cacheRoot({ LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming' })
    expect(root).toContain('Local')
    expect(root).not.toContain('Roaming')
  })

  test('follows XDG elsewhere', () => {
    if (process.platform === 'win32') return
    expect(cacheRoot({ XDG_CACHE_HOME: '/xdg' })).toBe('/xdg/rarn')
  })

  test('keys a package by name and version, matching the _Index spelling', () => {
    expect(cacheKey(promise, '4.0.0')).toBe('evaera_promise@4.0.0')
  })
})

describe('integrity', () => {
  test('produces a sha256- prefixed digest', () => {
    expect(computeIntegrity(new Uint8Array([1, 2, 3]))).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/)
  })

  test('is stable for identical bytes and differs otherwise', () => {
    expect(computeIntegrity(new Uint8Array([1]))).toBe(computeIntegrity(new Uint8Array([1])))
    expect(computeIntegrity(new Uint8Array([1]))).not.toBe(computeIntegrity(new Uint8Array([2])))
  })

  test('accepts matching bytes', () => {
    const bytes = new Uint8Array([9, 9, 9])
    expect(() => {
      verifyIntegrity(bytes, computeIntegrity(bytes), 'x')
    }).not.toThrow()
  })

  // A lockfile that pins a version but not its bytes pins nothing that matters.
  test('rejects bytes that do not match, showing both digests', () => {
    const error = (() => {
      try {
        verifyIntegrity(new Uint8Array([1]), computeIntegrity(new Uint8Array([2])), 'pkg@1.0.0')
        return undefined
      } catch (e) {
        return e as RarnError
      }
    })()
    expect(error?.code).toBe(Code.IntegrityMismatch)
    expect(error?.detail).toContain('expected:')
    expect(error?.detail).toContain('actual:')
  })

  test('rejects a digest that is not sha256 at all', () => {
    expect(() => {
      verifyIntegrity(new Uint8Array(), 'md5-abc', 'x')
    }).toThrow(RarnError)
  })
})

describe('archive', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarn-arc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // The registry answers `Content-Type: application/gzip` with a ZIP body, so the
  // header cannot be trusted and the magic bytes decide.
  test('detects a ZIP by its magic bytes', () => {
    expect(isZip(makeZip({ 'a.luau': 'x' }))).toBe(true)
    expect(isZip(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe(false)
    expect(isZip(new Uint8Array([]))).toBe(false)
  })

  test('extracts files and nested directories', async () => {
    const zip = makeZip({ 'init.luau': 'return 1', 'sub/deep.luau': 'return 2' })
    const result = await extractZip(zip, dir, 'pkg')
    expect(result.files).toHaveLength(2)
    expect(await readFile(join(dir, 'init.luau'), 'utf8')).toBe('return 1')
    expect(await readFile(join(dir, 'sub', 'deep.luau'), 'utf8')).toBe('return 2')
  })

  /**
   * A file over 512 KiB, which is where this broke.
   *
   * fflate's async `unzip` hands entries above that to a worker, and under Bun the
   * worker returns nothing — `undefined is not an object (evaluating 'dat.length')`.
   * The same archives inflate correctly under Node, so the suite would have had to run
   * on the runtime Rarn actually ships as to see it, which it does.
   *
   * The boundary is the **uncompressed** size, so the fixture is a highly compressible
   * megabyte: a few hundred bytes of archive that expands past the threshold. A test
   * that only made the archive big would not have caught it.
   */
  test('extracts a file larger than the async inflate threshold', async () => {
    const big = 'a'.repeat(1024 * 1024)
    const zip = makeZip({ 'init.luau': 'return 1', 'data/dump.json': big })
    expect(zip.length).toBeLessThan(64 * 1024)

    const result = await extractZip(zip, dir, 'pkg')
    expect(result.files).toHaveLength(2)
    expect((await readFile(join(dir, 'data', 'dump.json'), 'utf8')).length).toBe(big.length)
  })

  test('refuses bytes that are not a ZIP, and says what it saw', async () => {
    const error = await expectRejection(() =>
      extractZip(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), dir, 'pkg'),
    )
    expect(error.code).toBe(Code.ArchiveUnreadable)
    expect(error.detail).toContain('1f 8b')
  })

  // Zip slip: one traversal entry is enough to reject the whole archive.
  test('rejects an entry that escapes the destination', async () => {
    const error = await expectRejection(() =>
      extractZip(makeZip({ '../escaped.luau': 'x' }), dir, 'pkg'),
    )
    expect(error.code).toBe(Code.ArchiveUnsafePath)
    expect(error.detail).toContain('outside the package')
  })

  test('rejects an absolute entry path', async () => {
    const error = await expectRejection(() =>
      extractZip(makeZip({ '/etc/passwd': 'x' }), dir, 'pkg'),
    )
    expect(error.code).toBe(Code.ArchiveUnsafePath)
  })

  test('rejects a deep traversal', async () => {
    await expectRejection(() => extractZip(makeZip({ 'a/../../b.luau': 'x' }), dir, 'pkg'))
  })

  // Wally's packer notes that archives built on Windows can embed backslashes, which
  // on Unix extract as one long filename instead of a directory tree. Packages
  // published before their fix are still in the registry.
  test('normalizes Windows backslash separators into real directories', async () => {
    const zip = makeZip({ 'lib\\init.luau': 'return 1' })
    await extractZip(zip, dir, 'pkg')
    expect((await stat(join(dir, 'lib'))).isDirectory()).toBe(true)
    expect(await readFile(join(dir, 'lib', 'init.luau'), 'utf8')).toBe('return 1')
  })
})

describe('cache store', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarn-cache-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const zip = () => makeZip({ 'init.luau': 'return 1' })

  test('downloads, extracts, and reports it was not cached', async () => {
    const store = createCacheStore(root)
    const result = await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))

    expect(result.fromCache).toBe(false)
    expect(result.integrity).toBe(computeIntegrity(zip()))
    expect(await readFile(join(result.dir, 'init.luau'), 'utf8')).toBe('return 1')
  })

  // The whole point of the extracted tier.
  test('a second call does no network and no inflate', async () => {
    const store = createCacheStore(root)
    let downloads = 0
    const fetcher = () => {
      downloads++
      return Promise.resolve(zip())
    }

    await store.ensure(promise, '4.0.0', fetcher)
    const second = await store.ensure(promise, '4.0.0', fetcher)

    expect(downloads).toBe(1)
    expect(second.fromCache).toBe(true)
    expect(second.integrity).toBe(computeIntegrity(zip()))
  })

  test('a different store instance still hits the same cache', async () => {
    let downloads = 0
    const fetcher = () => {
      downloads++
      return Promise.resolve(zip())
    }
    await createCacheStore(root).ensure(promise, '4.0.0', fetcher)
    const again = await createCacheStore(root).ensure(promise, '4.0.0', fetcher)

    expect(downloads).toBe(1)
    expect(again.fromCache).toBe(true)
  })

  test('caches each version separately', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    const other = await store.ensure(promise, '3.2.1', () => Promise.resolve(zip()))
    expect(other.fromCache).toBe(false)
    expect(other.dir).toContain('3.2.1')
  })

  test('verifies against a recorded digest and refuses a mismatch', async () => {
    const store = createCacheStore(root)
    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', () => Promise.resolve(zip()), 'sha256-wrongwrongwrong='),
    )
    expect(error.code).toBe(Code.IntegrityMismatch)
  })

  test('verifies a cached archive too, and never serves one rarn.lock disagrees with', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))

    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', () => Promise.resolve(zip()), 'sha256-wrongwrongwrong='),
    )
    expect(error.code).toBe(Code.IntegrityMismatch)
  })

  // Hashing nothing and calling it a digest would put a value in the lockfile that
  // describes no real bytes.
  test('refetches when the archive was pruned but the tree remains', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    await rm(downloadPath(root, cacheKey(promise, '4.0.0')), { force: true })

    let downloads = 0
    const again = await store.ensure(promise, '4.0.0', () => {
      downloads++
      return Promise.resolve(zip())
    })
    expect(downloads).toBe(1)
    expect(again.integrity).toBe(computeIntegrity(zip()))
  })

  test('leaves nothing behind when the archive is not a ZIP', async () => {
    const store = createCacheStore(root)
    await expectRejection(() =>
      store.ensure(promise, '4.0.0', () => Promise.resolve(new Uint8Array([1, 2, 3, 4]))),
    )
    // A failed install must not leave a directory that later looks like a valid entry.
    expect(await pathExists(extractedPath(root, cacheKey(promise, '4.0.0')))).toBe(false)
  })

  test('concurrent calls for the same package both succeed', async () => {
    const store = createCacheStore(root)
    const results = await Promise.all([
      store.ensure(promise, '4.0.0', () => Promise.resolve(zip())),
      store.ensure(promise, '4.0.0', () => Promise.resolve(zip())),
    ])
    for (const result of results) {
      expect(await readFile(join(result.dir, 'init.luau'), 'utf8')).toBe('return 1')
    }
  })

  test('surfaces a download failure rather than caching it', async () => {
    const store = createCacheStore(root)
    await expectRejection(() =>
      store.ensure(promise, '4.0.0', () =>
        Promise.reject(new RarnError({ code: Code.DownloadFailed, what: 'nope' })),
      ),
    )

    let downloads = 0
    await store.ensure(promise, '4.0.0', () => {
      downloads++
      return Promise.resolve(zip())
    })
    expect(downloads).toBe(1)
  })
})

/**
 * A cached archive that disagrees with rarn.lock has two possible culprits, and only
 * one of them has been asked. The registry is not consulted by reading the cache, so
 * blaming it there names a party that said nothing — and the advice that came with
 * the blame, delete rarn.lock, then records the damaged bytes as the pinned ones.
 */
describe('cache store, when the cache disagrees with rarn.lock', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarn-cache-damage-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const zip = () => makeZip({ 'init.luau': 'return 1' })
  const damaged = () => makeZip({ 'init.luau': 'return "not what was pinned"' })
  const archive = () => downloadPath(root, cacheKey(promise, '4.0.0'))

  function counting(bytes: () => Uint8Array) {
    const fetcher = {
      calls: 0,
      fetch: () => {
        fetcher.calls++
        return Promise.resolve(bytes())
      },
    }
    return fetcher
  }

  test('a damaged cached archive is discarded and downloaded again', async () => {
    const store = createCacheStore(root)
    const pinned = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity
    await writeFile(archive(), damaged())

    const registry = counting(zip)
    const repaired = await store.ensure(promise, '4.0.0', registry.fetch, pinned)

    expect(registry.calls).toBe(1)
    expect(repaired.fromCache).toBe(false)
    expect(repaired.integrity).toBe(pinned)
    // Reported rather than healed in silence: the cache held bytes nobody pinned.
    expect(repaired.discarded).toBe(computeIntegrity(damaged()))
    expect(await readFile(join(repaired.dir, 'init.luau'), 'utf8')).toBe('return 1')

    // And the repair sticks: the next run is warm again.
    const next = await store.ensure(promise, '4.0.0', registry.fetch, pinned)
    expect(next.fromCache).toBe(true)
    expect(next.discarded).toBeUndefined()
    expect(registry.calls).toBe(1)
  })

  test('blames the registry only once it has served the wrong bytes itself', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    const pinned = computeIntegrity(damaged())

    const registry = counting(zip)
    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', registry.fetch, pinned),
    )

    expect(error.code).toBe(Code.IntegrityMismatch)
    expect(error.how).toContain('registry served')
    expect(registry.calls).toBe(1)
  })

  const offline = () => Promise.reject(networkBlockedError('https://api.wally.run/'))

  // One cache, two projects. B's lockfile agrees with the cache and the registry; A's
  // pins bytes the registry never served. A has to fail, and B, offline, must not
  // notice that it did: A's lockfile says nothing about an entry the registry itself
  // just vouched for, and deleting it on A's word turns B's offline install into RN0130.
  test('a lockfile the registry disagrees with costs no other project its cached copy', async () => {
    const store = createCacheStore(root)
    const pinnedByB = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity

    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', counting(zip).fetch, computeIntegrity(damaged())),
    )
    expect(error.code).toBe(Code.IntegrityMismatch)

    const b = await store.ensure(promise, '4.0.0', offline, pinnedByB)
    expect(b.fromCache).toBe(true)

    // The registry and the cache agree, so the message can say which of the three is
    // the odd one out rather than leave the reader to work it out.
    expect(error.detail).toContain('rarn.lock is the one that differs')
  })

  // The same rule with the registry out of reach: two records disagree and nothing can
  // say which is wrong, so the shared copy is left exactly as it was.
  test('a repair that cannot download leaves the cached copy where it was', async () => {
    const store = createCacheStore(root)
    const pinnedByB = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity

    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', offline, computeIntegrity(damaged())),
    )
    expect(error.code).toBe(Code.NetworkBlocked)

    const b = await store.ensure(promise, '4.0.0', offline, pinnedByB)
    expect(b.fromCache).toBe(true)
  })

  // Two installs meet the same unusable entry and both download. The first repairs it
  // and hands the tree to its linker; the second, finishing later, still holds a
  // verdict read before its download and must not act on it — the entry it would
  // remove is now correct and being copied from. The marker stands in for that copy:
  // a tree removed and extracted again comes back without it.
  test.each([
    ['disagrees with rarn.lock', () => writeFile(archive(), damaged())],
    ['has lost its archive', () => rm(archive(), { force: true })],
  ])('a late repair of an entry that %s leaves the finished one alone', async (_, spoil) => {
    const pinned = (
      await createCacheStore(root).ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    ).integrity
    await spoil()

    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const late = createCacheStore(root).ensure(
      promise,
      '4.0.0',
      async () => {
        arrived()
        await gate
        return zip()
      },
      pinned,
    )
    await waiting

    const first = await createCacheStore(root).ensure(
      promise,
      '4.0.0',
      () => Promise.resolve(zip()),
      pinned,
    )
    const inUse = join(first.dir, 'in-use')
    await writeFile(inUse, '')

    open()
    const second = await late

    expect(await pathExists(inUse)).toBe(true)
    expect(second.dir).toBe(first.dir)
    expect(second.integrity).toBe(pinned)
    // Whatever was thrown out, the first run threw out and reported.
    expect(second.discarded).toBeUndefined()
    expect(await readFile(join(second.dir, 'init.luau'), 'utf8')).toBe('return 1')
  })

  // The same race, with the late run's download returning while the other repair is
  // still partway: it has removed the damaged entry, or written its archive and not yet
  // its tree. Either way there is no finished tree to return, so the late run writes one
  // — but the damaged bytes were gone before it looked again, and the run that removed
  // them is the one that reports them. Named here as well, one discard is counted twice.
  test.each([
    ['removed the damaged entry', () => rm(archive(), { force: true })],
    ['written its archive but not its tree', () => writeFile(archive(), zip())],
  ])('a late repair does not report bytes another run has %s', async (_, other) => {
    const pinned = (
      await createCacheStore(root).ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    ).integrity
    await writeFile(archive(), damaged())

    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const late = createCacheStore(root).ensure(
      promise,
      '4.0.0',
      async () => {
        arrived()
        await gate
        return zip()
      },
      pinned,
    )
    await waiting

    await rm(extractedPath(root, cacheKey(promise, '4.0.0')), { recursive: true, force: true })
    await other()

    open()
    const repaired = await late

    expect(repaired.discarded).toBeUndefined()
    expect(await readFile(join(repaired.dir, 'init.luau'), 'utf8')).toBe('return 1')
    expect(await readFile(archive())).toEqual(Buffer.from(zip()))
  })

  // The other side of it: once the registry has answered and disowns the cached bytes
  // too, they go, even though this run fails. RN0300 advises deleting rarn.lock and
  // reinstalling, and a run with no lockfile takes the cache at its word — so what it
  // records has to be what the registry serves, not what the cache held.
  test('bytes the registry disowns do not outlive the run that asked it', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(damaged()))
    const served = () => makeZip({ 'init.luau': 'return "what the registry serves"' })

    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', () => Promise.resolve(served()), computeIntegrity(zip())),
    )
    expect(error.code).toBe(Code.IntegrityMismatch)
    expect(error.detail).toContain(computeIntegrity(damaged()))
    // Gone whole. An archive left without its tree is never read by an install, but
    // `rarn cache verify` would go on reporting bytes nothing holds any more.
    expect(await pathExists(archive())).toBe(false)
    expect(await pathExists(extractedPath(root, cacheKey(promise, '4.0.0')))).toBe(false)

    const unpinned = await store.ensure(promise, '4.0.0', () => Promise.resolve(served()))
    expect(unpinned.integrity).toBe(computeIntegrity(served()))
  })

  // Every fixture above damages the archive and leaves the tree alone, so a repair that
  // replaced only the archive would pass them all and install the old tree. Here the
  // two agree with each other and not with rarn.lock — what a cache holds when the same
  // version reached it from somewhere else first.
  test('a repaired entry installs the new bytes, not the tree they replace', async () => {
    const store = createCacheStore(root)
    const older = () => makeZip({ 'init.luau': 'return "old"' })
    const newer = () => makeZip({ 'init.luau': 'return "new"' })
    await store.ensure(promise, '4.0.0', () => Promise.resolve(older()))

    const repaired = await store.ensure(
      promise,
      '4.0.0',
      () => Promise.resolve(newer()),
      computeIntegrity(newer()),
    )

    expect(repaired.discarded).toBe(computeIntegrity(older()))
    expect(await readFile(join(repaired.dir, 'init.luau'), 'utf8')).toBe('return "new"')
    expect(await readFile(archive())).toEqual(Buffer.from(newer()))
  })

  // The same property for a tree that lost its archive, which is what a repair leaves
  // when it stops after removing the archive — between the two, or partway through the
  // tree, as a Windows `rm` refused by an open file does. Refetching the same bytes
  // cannot tell the old tree from a new one, so these serve different bytes.
  test.each([
    ['whole, and rarn.lock pins the new bytes', false, true],
    ['whole, with no rarn.lock', false, false],
    ['half removed', true, true],
  ])('a tree without its archive (%s) is replaced, not vouched for', async (_, half, pinned) => {
    const store = createCacheStore(root)
    const older = () => makeZip({ 'init.luau': 'return "old"', 'b.luau': 'return "old"' })
    const newer = () => makeZip({ 'init.luau': 'return "new"', 'b.luau': 'return "new"' })
    const first = await store.ensure(promise, '4.0.0', () => Promise.resolve(older()))
    await rm(archive(), { force: true })
    if (half) await rm(join(first.dir, 'b.luau'))

    const repaired = await store.ensure(
      promise,
      '4.0.0',
      () => Promise.resolve(newer()),
      pinned ? computeIntegrity(newer()) : undefined,
    )

    expect(repaired.integrity).toBe(computeIntegrity(newer()))
    expect(await readFile(join(repaired.dir, 'init.luau'), 'utf8')).toBe('return "new"')
    expect(await readFile(join(repaired.dir, 'b.luau'), 'utf8')).toBe('return "new"')
  })

  // `refetch` rebuilds the error to add context, and the class is what picks the exit
  // code: 2 tells a script the network flaked and a retry may help. Rebuilt as a plain
  // RarnError, every flaky download during a repair would exit 1 and stop the retry.
  test.each([
    ['disagrees with rarn.lock', () => writeFile(archive(), damaged())],
    ['has lost its archive', () => rm(archive(), { force: true })],
  ])('a transport failure while the cached copy %s still exits as one', async (_, spoil) => {
    const store = createCacheStore(root)
    const pinned = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity
    await spoil()

    const error = await expectRejection(() =>
      store.ensure(
        promise,
        '4.0.0',
        () =>
          Promise.reject(
            new RegistryError({
              code: Code.RegistryUnreachable,
              what: 'Could not reach the registry.',
            }),
          ),
        pinned,
      ),
    )

    expect(error).toBeInstanceOf(RegistryError)
    expect(error.code).toBe(Code.RegistryUnreachable)
    expect(error.what).toContain('cached copy')
    expect(exitCodeFor(error)).toBe(ExitCode.RegistryError)
  })

  // Constraint 2c: offline is a guarantee. The repair needs the network, so under
  // `--offline` it has to stop with the offline code — and say why an install that
  // looked fully cached needed the network at all.
  test('offline, the repair fails with RN0130 and says the cached copy disagreed with rarn.lock', async () => {
    const store = createCacheStore(root)
    const pinned = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity
    await writeFile(archive(), damaged())

    const error = await expectRejection(() =>
      store.ensure(
        promise,
        '4.0.0',
        () => Promise.reject(networkBlockedError('https://api.wally.run/v1/package-contents')),
        pinned,
      ),
    )

    expect(error.code).toBe(Code.NetworkBlocked)
    expect(error.what).toContain('cached copy')
    expect(error.detail).toContain(computeIntegrity(damaged()))
    expect(error.format()).not.toContain('registry served')
    // Kept as the class it was, which for `--offline` is not a transport failure:
    // retrying the same command cannot help.
    expect(exitCodeFor(error)).toBe(ExitCode.UserError)
  })

  test('offline, a tree whose archive is gone says so too', async () => {
    const store = createCacheStore(root)
    const pinned = (await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))).integrity
    await rm(archive(), { force: true })

    const error = await expectRejection(() =>
      store.ensure(
        promise,
        '4.0.0',
        () => Promise.reject(networkBlockedError('https://api.wally.run/')),
        pinned,
      ),
    )
    expect(error.code).toBe(Code.NetworkBlocked)
    expect(error.what).toContain('cached copy')
  })

  // A malformed digest is a lockfile problem. Read as a cache that disagrees with it, it
  // would start a repair: online, a request that can only reach this same error; offline,
  // RN0130 and a message blaming the cached copy for what is wrong with rarn.lock.
  test('a malformed recorded digest is reported as itself, before the cache is touched', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))

    const registry = counting(zip)
    const error = await expectRejection(() =>
      store.ensure(promise, '4.0.0', registry.fetch, 'md5-abc'),
    )
    expect(error.code).toBe(Code.LockfileInvalid)
    expect(registry.calls).toBe(0)
    expect(await readFile(archive())).toEqual(Buffer.from(zip()))
  })

  // Where the order shows. Online the repair would only cost a request before reaching
  // the same RN0500; offline it never gets there, and the reader is told the network was
  // off and the cache was wrong when the only thing wrong is rarn.lock.
  test('offline, a malformed recorded digest is still a lockfile problem, not RN0130', async () => {
    const store = createCacheStore(root)
    await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))

    const error = await expectRejection(() => store.ensure(promise, '4.0.0', offline, 'md5-abc'))
    expect(error.code).toBe(Code.LockfileInvalid)
    expect(error.format()).not.toContain('cached copy')
  })

  // The boundary, pinned so the comment in `ensure` cannot drift from it again. Only
  // the archive is hashed; `ensure` says what hashing every unpacked file would cost.
  // Whoever adds that check changes this test, and the comment along with it.
  test('only the archive is verified; the unpacked tree is trusted as local state', async () => {
    const store = createCacheStore(root)
    const first = await store.ensure(promise, '4.0.0', () => Promise.resolve(zip()))
    await writeFile(join(first.dir, 'init.luau'), 'return "edited in the cache"')

    const again = await store.ensure(promise, '4.0.0', counting(zip).fetch, first.integrity)
    expect(again.fromCache).toBe(true)
    expect(await readFile(join(again.dir, 'init.luau'), 'utf8')).toBe(
      'return "edited in the cache"',
    )
  })
})

describe('mapWithConcurrency', () => {
  test('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1]
    const out = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2, 3])
  })

  test('never exceeds the limit', async () => {
    let running = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 2))
        running--
      },
    )
    expect(peak).toBeLessThanOrEqual(3)
  })

  test('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([])
  })

  // Continuing to download after a failure only delays the report.
  test('propagates the first failure and stops starting work', async () => {
    let started = 0
    let caught: unknown
    try {
      await mapWithConcurrency(
        Array.from({ length: 50 }, (_, i) => i),
        2,
        async (i) => {
          started++
          await new Promise((r) => setTimeout(r, 1))
          if (i === 1) throw new Error('boom')
          return i
        },
      )
    } catch (error) {
      caught = error
    }
    expect((caught as Error | undefined)?.message).toBe('boom')
    expect(started).toBeLessThan(50)
  })

  /**
   * The caller's cleanup runs in a `finally`, so returning while workers are still
   * writing means the cleanup deletes a directory that then fills up behind it. That is
   * not hypothetical: it is what `link` did the day its prune loop became concurrent —
   * the staging tree survived a failed install, which is the one thing that `finally`
   * exists to prevent.
   */
  test('waits for work already in flight before the failure propagates', async () => {
    let running = 0
    let peakAfterFailure = 0
    let failed = false

    await mapWithConcurrency(
      Array.from({ length: 8 }, (_, i) => i),
      4,
      async (i) => {
        running++
        // The first item fails immediately; the other three in flight linger.
        if (i === 0) {
          failed = true
          running--
          throw new Error('boom')
        }
        await new Promise((r) => setTimeout(r, 20))
        if (failed) peakAfterFailure = Math.max(peakAfterFailure, running)
        running--
        return i
      },
    ).catch(() => undefined)

    expect(peakAfterFailure).toBeGreaterThan(0)
    expect(running).toBe(0)
  })

  /**
   * Callers sort their input so that a rerun reports the same item first. Concurrency
   * would take that away if the reported failure were whichever lost the race, so it is
   * the lowest-indexed one instead — which is well defined, since indices are handed out
   * in order and anything before a failure either finished or failed itself.
   */
  test('reports the lowest-indexed failure, not the fastest', async () => {
    let caught: unknown
    try {
      await mapWithConcurrency(
        Array.from({ length: 8 }, (_, i) => i),
        4,
        async (i) => {
          // 3 fails late, 1 fails early. Racing would report 3; ordering reports 1.
          if (i === 3) throw new Error('three')
          if (i === 1) {
            await new Promise((r) => setTimeout(r, 30))
            throw new Error('one')
          }
          return i
        },
      )
    } catch (error) {
      caught = error
    }

    expect((caught as Error | undefined)?.message).toBe('one')
  })
})

describe('atomic writes', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarn-atomic-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // An existing target means another process finished first. On Windows rename
  // refuses to replace, so that race has to be handled rather than crashed on.
  test('accepts an entry another process finished first', async () => {
    const store = createCacheStore(root)
    const key = cacheKey(promise, '4.0.0')
    const zip = makeZip({ 'init.luau': 'return 1' })

    const { mkdir } = await import('node:fs/promises')
    await mkdir(extractedPath(root, key), { recursive: true })
    await writeFile(join(extractedPath(root, key), 'init.luau'), 'return 1')
    await mkdir(join(root, 'downloads'), { recursive: true })
    await writeFile(downloadPath(root, key), zip)

    const result = await store.ensure(promise, '4.0.0', () => Promise.resolve(zip))
    expect(result.fromCache).toBe(true)
  })
})
