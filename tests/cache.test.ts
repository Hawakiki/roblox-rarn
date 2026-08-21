import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { extractZip, isZip } from '../src/cache/archive.ts'
import { computeIntegrity, verifyIntegrity } from '../src/cache/integrity.ts'
import { cacheKey, cacheRoot, downloadPath, extractedPath } from '../src/cache/paths.ts'
import { createCacheStore } from '../src/cache/store.ts'
import { Code } from '../src/util/codes.ts'
import { mapWithConcurrency } from '../src/util/concurrency.ts'
import { RarnError } from '../src/util/errors.ts'
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

  test('verifies a cached entry too, so a tampered cache cannot slip through', async () => {
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
    const { pathExists } = await import('../src/util/fs.ts')
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
