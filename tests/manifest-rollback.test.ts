import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { add } from '../src/cli/commands/add.ts'
import { remove } from '../src/cli/commands/remove.ts'
import { up } from '../src/cli/commands/up.ts'
import { normalizeManifest } from '../src/manifest/read.ts'
import { writeManifestThen } from '../src/manifest/write.ts'
import type {
  PackageMetadata,
  PackageVersion,
  RegistryClient,
  SearchResult,
} from '../src/registry/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { type PackageName, toWallyName } from '../src/util/package-name.ts'

/**
 * RN-27. `add`, `up` and `remove` wrote `rarn.json` and then installed, and an install
 * that failed left the new manifest behind with the old lockfile. When the failure was
 * the new range, every `rarn install` after it failed the same way, and the project
 * stayed stuck until someone edited the file by hand.
 *
 * Each case compares the file's *text* before and after: a manifest that comes back
 * with the same contents in another key order is still a diff in someone's review.
 */

let dir: string
let cacheDir: string
let previousCacheDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-rollback-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'rarn-rollback-cache-'))
  previousCacheDir = process.env.RARN_CACHE_DIR
  process.env.RARN_CACHE_DIR = cacheDir
})
afterEach(async () => {
  // `Reflect.deleteProperty`, because assigning undefined stores the string "undefined".
  if (previousCacheDir === undefined) Reflect.deleteProperty(process.env, 'RARN_CACHE_DIR')
  else process.env.RARN_CACHE_DIR = previousCacheDir
  await rm(dir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

interface Failures {
  /** Metadata requests fail, as they do offline or with the registry down. */
  metadata?: boolean
  /** Downloads fail, after resolution has already succeeded. */
  contents?: boolean
}

function registryOf(
  published: Record<string, readonly string[]>,
  failures: Failures = {},
): RegistryClient {
  return {
    getMetadata(name: PackageName): Promise<PackageMetadata> {
      const versions = published[toWallyName(name)]
      if (failures.metadata === true) return Promise.reject(new Error('registry unreachable'))
      if (versions === undefined) return Promise.reject(new Error(`no such package ${name.name}`))
      return Promise.resolve({
        name,
        versions: versions.map(
          (version): PackageVersion => ({
            name,
            version,
            realm: 'shared',
            dependencies: new Map(),
            serverDependencies: new Map(),
            devDependencies: new Map(),
            place: {},
            description: undefined,
            license: undefined,
          }),
        ),
      })
    },
    getContents(name: PackageName): Promise<Uint8Array> {
      if (failures.contents === true) return Promise.reject(new Error('download failed'))
      return Promise.resolve(
        zipSync(
          { 'init.luau': new TextEncoder().encode(`return "${name.name}"`) },
          { mtime: new Date(2020, 0, 1).getTime() },
        ),
      )
    },
    search(): Promise<readonly SearchResult[]> {
      return Promise.resolve([])
    },
    apiBase(): Promise<string> {
      return Promise.resolve('https://api.example/')
    },
    publish(): Promise<never> {
      return Promise.reject(new Error('never publishes'))
    },
  }
}

const PUBLISHED = {
  'evaera/promise': ['4.0.0', '3.2.1'],
  'sleitnick/signal': ['2.0.3', '1.5.0'],
}

/**
 * Written by hand, in an order Rarn would not write it, so that putting back a
 * re-serialized copy would be caught as surely as leaving the change in.
 */
const MANIFEST = `{
  "version": "1.0.0",
  "name": "@me/game",
  "dependencies": { "@sleitnick/signal": "^2.0.0", "@evaera/promise": "^4.0.0" }
}
`

async function project(): Promise<void> {
  await writeFile(join(dir, 'rarn.json'), MANIFEST)
}

function manifestText(): Promise<string> {
  return readFile(join(dir, 'rarn.json'), 'utf8')
}

/** Runs `action`, returning what it printed and what it threw. */
async function captured(action: () => Promise<void>): Promise<{ out: string; error: unknown }> {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk))
    return true
  }
  let error: unknown
  try {
    await action()
  } catch (thrown) {
    error = thrown
  } finally {
    process.stdout.write = original
  }
  return { out: written.join('').replaceAll(ANSI, ''), error }
}

describe('a failed rarn add', () => {
  // The reported case, exactly: a major that was never published.
  test('leaves rarn.json as it was, and announces nothing', async () => {
    await project()

    const { out, error } = await captured(() =>
      add({ cwd: dir, specs: ['@evaera/promise@^9.0.0'] }, registryOf(PUBLISHED)),
    )

    expect((error as RarnError).code).toBe(Code.UnresolvableRange)
    expect(await manifestText()).toBe(MANIFEST)
    expect(out).not.toContain('added')
  })

  test('leaves rarn.json as it was when the package does not exist', async () => {
    await project()

    const { error } = await captured(() =>
      add({ cwd: dir, specs: ['@nope/doesnotexist@^1.0.0'] }, registryOf(PUBLISHED)),
    )

    expect((error as Error).message).toContain('no such package')
    expect(await manifestText()).toBe(MANIFEST)
  })

  // Not only a bad range: a download that fails after resolution succeeded is the same
  // half-applied command, and the next install would have quietly finished it.
  test('leaves rarn.json as it was when the download fails', async () => {
    await project()

    const { error } = await captured(() =>
      add(
        { cwd: dir, specs: ['@sleitnick/signal@^1.5.0'] },
        registryOf(PUBLISHED, { contents: true }),
      ),
    )

    expect((error as Error).message).toContain('download failed')
    expect(await manifestText()).toBe(MANIFEST)
  })

  test('a successful add still writes the range, and says so after installing', async () => {
    await project()

    const { out, error } = await captured(() =>
      add({ cwd: dir, specs: ['@sleitnick/signal@^1.5.0'] }, registryOf(PUBLISHED)),
    )

    expect(error).toBeUndefined()
    const written = JSON.parse(await manifestText()) as { dependencies: Record<string, string> }
    expect(written.dependencies['@sleitnick/signal']).toBe('^1.5.0')
    expect(out.indexOf('added @sleitnick/signal@^1.5.0')).toBeGreaterThan(out.indexOf('installed'))
  })
})

describe('a failed rarn up', () => {
  test('leaves rarn.json as it was', async () => {
    await project()

    const { out, error } = await captured(() =>
      up({ cwd: dir, specs: [], latest: false }, registryOf(PUBLISHED, { contents: true })),
    )

    expect((error as Error).message).toContain('download failed')
    expect(await manifestText()).toBe(MANIFEST)
    expect(out).not.toMatch(/^up /m)
  })
})

describe('a failed rarn remove', () => {
  // A remove re-resolves what is left, so with the registry unreachable it fails
  // before linking. The dependency must still be declared afterwards: in a real project
  // the tree on disk still holds it, and a manifest that says otherwise is the
  // mismatch this prevents.
  test('leaves rarn.json as it was', async () => {
    await project()

    const { out, error } = await captured(() =>
      remove({ cwd: dir, specs: ['@evaera/promise'] }, registryOf(PUBLISHED, { metadata: true })),
    )

    expect((error as Error).message).toContain('registry unreachable')
    expect(await manifestText()).toBe(MANIFEST)
    expect(out).not.toContain('removed')
  })
})

describe('writeManifestThen', () => {
  const next = normalizeManifest({ name: '@me/game', version: '2.0.0' })

  test('returns what the work returned, and keeps the new manifest', async () => {
    await project()

    const result = await writeManifestThen(dir, next, () => Promise.resolve(42))

    expect(result).toBe(42)
    expect(await manifestText()).toContain('"version": "2.0.0"')
  })

  test('rethrows the original error, not anything about the restore', async () => {
    await project()
    const original = new RarnError({ code: Code.UnresolvableRange, what: 'no version fits' })

    const thrown = await writeManifestThen(dir, next, () => Promise.reject(original)).catch(
      (e: unknown) => e,
    )

    expect(thrown).toBe(original)
    expect(await manifestText()).toBe(MANIFEST)
  })

  // A rollback that fails quietly is the defect again with extra steps: the change
  // stays in the file and the person was told nothing changed. The path is taken
  // away by putting a directory where the file was.
  test('says so when the manifest cannot be put back, with the first error', async () => {
    await project()
    const path = join(dir, 'rarn.json')

    const thrown = (await writeManifestThen(dir, next, async () => {
      await rm(path)
      await mkdir(path)
      throw new RarnError({ code: Code.UnresolvableRange, what: 'no version fits' })
    }).catch((e: unknown) => e)) as RarnError

    expect(thrown).toBeInstanceOf(RarnError)
    expect(thrown.code).toBe(Code.ManifestUnreadable)
    expect(thrown.where).toBe(path)
    expect(thrown.detail).toContain(`${Code.UnresolvableRange}: no version fits`)
    expect(thrown.how).toContain('still holds the change')
  })
})
