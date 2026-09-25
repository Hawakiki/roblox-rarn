import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { install } from '../src/cli/commands/install.ts'
import { outdated } from '../src/cli/commands/outdated.ts'
import { up } from '../src/cli/commands/up.ts'
import type {
  PackageMetadata,
  PackageVersion,
  RegistryClient,
  SearchResult,
} from '../src/registry/types.ts'
import { type PackageName, toWallyName } from '../src/util/package-name.ts'

/**
 * `rarn up` without `--latest` promises the newest version *the declared range already
 * allows*. It wrote every range back as a caret, so `~1.2.0` came out as `^1.2.5` and
 * `>=1.0.0 <1.5.0` as `^1.4.2` — and the reinstall that follows resolves the rewritten
 * range, not the one the person wrote. The upgrade therefore landed outside the bound
 * it was asked to respect, and reported success.
 *
 * Driven through the command rather than the range function alone, because the harm
 * is only visible at the far end: in the manifest and in what got installed.
 */

let dir: string
let cacheDir: string
let previousCacheDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-up-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'rarn-up-cache-'))
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

function registryOf(published: Record<string, readonly string[]>): RegistryClient {
  return {
    getMetadata(name: PackageName): Promise<PackageMetadata> {
      const versions = published[toWallyName(name)]
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
      return Promise.reject(new Error('up must never publish'))
    },
  }
}

// Newest first, which is the order the registry layer guarantees.
const PUBLISHED = {
  'a/tilde': ['2.0.0', '1.3.0', '1.2.5', '1.2.0'],
  'a/bounded': ['2.0.0', '1.5.0', '1.4.2', '1.0.0'],
  'a/pinned': ['2.0.0', '1.2.4', '1.2.3'],
  'a/caret': ['2.0.0', '1.9.0', '1.2.0'],
  'a/zero': ['1.0.0', '0.5.2', '0.1.0'],
}

async function project(
  dependencies: Record<string, string>,
  rest: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(dir, 'rarn.json'),
    JSON.stringify({ name: '@me/game', version: '1.0.0', dependencies, ...rest }),
  )
}

async function captured(action: () => Promise<void>): Promise<string> {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: unknown) => {
    written.push(String(chunk))
    return true
  }
  try {
    await action()
  } finally {
    process.stdout.write = original
  }
  return written.join('').replaceAll(ANSI, '')
}

function run(
  options: { latest?: boolean; specs?: string[] } = {},
  published: Record<string, readonly string[]> = PUBLISHED,
): Promise<string> {
  return captured(() =>
    up(
      { cwd: dir, specs: options.specs ?? [], latest: options.latest === true },
      registryOf(published),
    ),
  )
}

async function declared(
  section: 'dependencies' | 'serverDependencies' = 'dependencies',
): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(dir, 'rarn.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >
  return manifest[section] ?? {}
}

async function installed(): Promise<string[]> {
  const lock = JSON.parse(await readFile(join(dir, 'rarn.lock'), 'utf8')) as {
    packages: Record<string, unknown>
  }
  return Object.keys(lock.packages).sort()
}

describe('rarn up without --latest', () => {
  test('keeps a tilde a tilde, so a minor release stays out', async () => {
    await project({ '@a/tilde': '~1.2.0' })
    await run()

    expect(await installed()).toEqual(['@a/tilde@1.2.5'])
    expect(await declared()).toEqual({ '@a/tilde': '~1.2.5' })
  })

  test('keeps the upper bound someone wrote, and raises only the floor', async () => {
    await project({ '@a/bounded': '>=1.0.0 <1.5.0' })
    await run()

    expect(await installed()).toEqual(['@a/bounded@1.4.2'])
    expect(await declared()).toEqual({ '@a/bounded': '>=1.4.2 <1.5.0' })
  })

  /**
   * `=1.2.3` is Cargo's exact pin, and `rarn import` writes it through unchanged. The
   * pin check read only the bare spelling, so this one was widened to a caret too.
   */
  test('leaves an exact pin alone in either spelling', async () => {
    await project({ '@a/pinned': '=1.2.3' })
    const output = await run()

    expect(await installed()).toEqual(['@a/pinned@1.2.3'])
    expect(await declared()).toEqual({ '@a/pinned': '=1.2.3' })
    expect(output).toContain('everything is already at the newest allowed version')
  })

  test('still raises a caret, which is what it has always done', async () => {
    await project({ '@a/caret': '^1.2.0' })
    const output = await run()

    expect(await declared()).toEqual({ '@a/caret': '^1.9.0' })
    expect(await installed()).toEqual(['@a/caret@1.9.0'])
    expect(output).toContain('^1.2.0 -> ^1.9.0')
  })

  /**
   * Everything above starts without a lockfile, and there the reinstall resolves fresh
   * whatever the manifest says — `~1.2.0` read again still gives 1.2.5. Only a
   * lockfile already holding the old version shows whether `up` moves the install:
   * a manifest left unchanged keeps the lockfile fresh, and the install reuses it.
   *
   * `^0` is what `rarn import` makes of `pkg@0`. A caret on 0.5.2 would stop at 0.6.0,
   * so `up` once declined to rewrite it at all, and the project stayed on 0.1.0 while
   * `rarn outdated` kept pointing at `rarn up` to fix it.
   */
  test.each([
    ['@a/tilde', '~1.2.0', ['1.2.0'], '@a/tilde@1.2.5', '~1.2.5'],
    ['@a/caret', '^1.2.0', ['1.2.0'], '@a/caret@1.9.0', '^1.9.0'],
    ['@a/zero', '^0', ['0.1.0'], '@a/zero@0.5.2', '>=0.5.2 <1'],
  ])('moves what a lockfile holds for %s %s', async (name, range, before, after, rewritten) => {
    const wally = name.slice(1)
    await project({ [name]: range })
    await install({ cwd: dir, silent: true }, registryOf({ ...PUBLISHED, [wally]: before }))
    expect(await installed()).toEqual([`${name}@${before[0] ?? ''}`])

    const output = await run()

    expect(await installed()).toEqual([after])
    expect(await declared()).toEqual({ [name]: rewritten })
    expect(output).not.toContain('kept')
  })

  /**
   * `>=0.5.2 <1.0.0-0` is the same range as `>=0.5.2 <1`, but the resolver looks at a
   * package's prereleases once any range on it names one. Written that way, the
   * rewrite installed 0.6.0-rc.1.
   */
  test('writes a ceiling that does not opt the project into prereleases', async () => {
    const published = { ...PUBLISHED, 'a/zero': ['1.0.0', '0.6.0-rc.1', '0.5.2', '0.1.0'] }
    await project({ '@a/zero': '^0' })
    await install({ cwd: dir, silent: true }, registryOf({ ...published, 'a/zero': ['0.1.0'] }))

    await run({}, published)

    expect(await installed()).toEqual(['@a/zero@0.5.2'])
    expect(await declared()).toEqual({ '@a/zero': '>=0.5.2 <1' })
  })

  /**
   * One package in two sections is one package, and the resolver installs it once, at
   * the newest version both ranges admit. Raising each range on its own would turn
   * `^1.2.0` and `~1.2.0` into `^1.3.0` and `~1.2.5` — two ranges with nothing in
   * common, written before the install that fails on them, so every install after
   * would fail too. 0.2.0 widened both to a caret instead and installed 1.3.0, past the
   * tilde.
   *
   * `rarn outdated` is asked first, since its `wanted` column says what `up` will get.
   */
  test.each([
    ['@a/tilde', '^1.2.0', '~1.2.0', '1.2.0', '1.2.5', '^1.2.5', '~1.2.5'],
    ['@a/bounded', '^1.0.0', '>=1.0.0 <1.5.0', '1.0.0', '1.4.2', '^1.4.2', '>=1.4.2 <1.5.0'],
  ])(
    'raises %s declared %s and %s to one version both allow',
    async (name, shared, server, before, after, sharedAfter, serverAfter) => {
      await project(
        { [name]: shared },
        {
          place: { sharedPackages: 'game.ReplicatedStorage.Packages' },
          serverDependencies: { [name]: server },
        },
      )
      const wally = name.slice(1)
      await install({ cwd: dir, silent: true }, registryOf({ ...PUBLISHED, [wally]: [before] }))

      const report = await captured(() => outdated({ cwd: dir, json: true }, registryOf(PUBLISHED)))
      const rows = JSON.parse(report) as { wanted: string }[]
      expect(rows.map((row) => row.wanted)).toEqual([after, after])

      await run()

      expect(await installed()).toEqual([`${name}@${after}`])
      expect([await declared('dependencies'), await declared('serverDependencies')]).toEqual([
        { [name]: sharedAfter },
        { [name]: serverAfter },
      ])
    },
  )
})

describe('rarn up --latest', () => {
  test('crosses the bound but keeps the operator', async () => {
    await project({ '@a/tilde': '~1.2.0', '@a/pinned': '=1.2.3', '@a/caret': '^1.2.0' })
    await run({ latest: true })

    expect(await declared()).toEqual({
      '@a/tilde': '~2.0.0',
      '@a/pinned': '=2.0.0',
      '@a/caret': '^2.0.0',
    })
  })

  /**
   * An explicit bound has no operator to keep, and `--latest` is the flag that says
   * to ignore it — so it becomes the caret `rarn add` would write.
   */
  test('replaces a compound range with a caret on the newest release', async () => {
    await project({ '@a/bounded': '>=1.0.0 <1.5.0' })
    await run({ latest: true })

    expect(await declared()).toEqual({ '@a/bounded': '^2.0.0' })
  })
})
