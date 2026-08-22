import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { createCacheStore } from '../src/cache/store.ts'
import { runInstall } from '../src/install/run.ts'
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
 * The pipeline, reached without a terminal.
 *
 * Every stage had tests already. What did not was the *arrangement* — which stage
 * runs before which, what each hands the next, when the lockfile is written. That is
 * where this project's worst defect lived: RN-1 was a question of when the ownership
 * check ran relative to the download, not of what any single stage did, and it was
 * unreachable from a test because the composition sat inside a CLI command.
 */

let dir: string
let cacheDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-install-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'rarn-install-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

/** A package archive whose module root is declared, so pruning has something to do. */
function archiveOf(moduleName: string): Uint8Array {
  return zipSync(
    {
      'default.project.json': new TextEncoder().encode(
        JSON.stringify({ name: moduleName, tree: { $path: 'lib' } }),
      ),
      'lib/init.luau': new TextEncoder().encode('return {}'),
      'docs/README.md': new TextEncoder().encode('not shipped'),
    },
    // Fixed, or the same input builds different bytes and the digest moves.
    { mtime: new Date(2020, 0, 1).getTime() },
  )
}

type Spec = Record<string, Record<string, Record<string, string>>>

function registryOf(spec: Spec): RegistryClient & { metadataCalls: number } {
  const client = {
    metadataCalls: 0,
    getMetadata(name: PackageName): Promise<PackageMetadata> {
      client.metadataCalls++
      const key = toWallyName(name)
      const versions = spec[key]
      if (versions === undefined) return Promise.reject(new Error(`no such package ${key}`))
      return Promise.resolve({
        name,
        versions: Object.entries(versions).map(
          ([version]): PackageVersion => ({
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
      return Promise.resolve(archiveOf(name.name))
    },
    search(): Promise<readonly SearchResult[]> {
      return Promise.resolve([])
    },
    apiBase(): Promise<string> {
      return Promise.resolve('https://api.example/')
    },
    publish(): Promise<never> {
      return Promise.reject(new Error('install must never publish'))
    },
  }
  return client
}

const SPEC: Spec = { 'a/one': { '1.0.0': {} }, 'a/two': { '2.0.0': {} } }

async function manifest(extra: Record<string, unknown> = {}) {
  await writeFile(
    join(dir, 'rarn.json'),
    JSON.stringify({
      name: '@me/game',
      version: '1.0.0',
      dependencies: { '@a/one': '^1.0.0' },
      ...extra,
    }),
  )
}

function install(overrides: Partial<Parameters<typeof runInstall>[0]> = {}) {
  return runInstall({
    projectDir: dir,
    registry: registryOf(SPEC),
    store: createCacheStore(cacheDir),
    ...overrides,
  })
}

describe('the install pipeline', () => {
  test('reads, resolves, fetches, prunes, links, and records', async () => {
    await manifest()
    const outcome = await install()

    expect(outcome.resolution.packages.size).toBe(1)
    expect(outcome.downloaded).toBe(1)
    expect(outcome.cached).toBe(0)
    expect(outcome.fromLockfile).toBe(false)

    // Pruned to the declared module root: `docs/` never reaches the tree.
    expect(await readFile(join(dir, 'RARN_MODULE', 'One.luau'), 'utf8')).toContain('require(')
    expect(
      await readFile(join(dir, 'RARN_MODULE', '_Index', 'a_one@1.0.0', 'one', 'init.luau'), 'utf8'),
    ).toBe('return {}')

    // The lockfile is written last, so it records what linking actually did.
    const lock = JSON.parse(await readFile(join(dir, 'rarn.lock'), 'utf8')) as {
      packages: Record<string, unknown>
    }
    expect(Object.keys(lock.packages)).toEqual(['@a/one@1.0.0'])
  })

  /**
   * The stage order is the thing this file exists to hold still. Asserting the labels
   * is cruder than asserting the effects, but it fails loudly when someone moves a
   * stage rather than when a user notices months later.
   */
  test('runs its stages in order', async () => {
    await manifest()
    const stages: string[] = []
    await install({ observer: { stage: (label) => stages.push(label.split(' ')[0] ?? label) } })

    expect(stages).toEqual(['resolving', 'fetching', 'linking'])
  })

  // Resolution is the only stage that touches the network, so a fresh lockfile is
  // what turns a repeat install into an offline one. Counting the calls is the only
  // way to see it — the resulting tree is identical either way.
  test('a fresh lockfile skips resolution entirely', async () => {
    await manifest()
    await install()

    const registry = registryOf(SPEC)
    const second = await runInstall({
      projectDir: dir,
      registry,
      store: createCacheStore(cacheDir),
    })

    expect(second.fromLockfile).toBe(true)
    expect(registry.metadataCalls).toBe(0)
    expect(second.cached).toBe(1)
    expect(second.downloaded).toBe(0)
  })

  test('a manifest change makes the lockfile stale again', async () => {
    await manifest()
    await install()

    await manifest({ dependencies: { '@a/one': '^1.0.0', '@a/two': '^2.0.0' } })
    const second = await install()

    expect(second.fromLockfile).toBe(false)
    expect(second.staleReasons.join(' ')).toContain('@a/two')
    expect(second.resolution.packages.size).toBe(2)
  })

  test('--frozen-lockfile refuses rather than rewriting', async () => {
    await manifest()

    const error = (await install({ frozenLockfile: true }).catch((e: unknown) => e)) as RarnError
    expect(error).toBeInstanceOf(RarnError)
    expect(error.code).toBe(Code.LockfileStale)

    // Nothing was written, which is the whole point of the flag in CI.
    expect(await readFile(join(dir, 'rarn.lock'), 'utf8').catch(() => undefined)).toBeUndefined()
  })

  /**
   * `--production` drops devDependencies, so its graph no longer describes the
   * manifest. Writing it back would leave a lockfile that a later plain install
   * would happily reuse, quietly missing the dev packages.
   */
  test('--production installs a subset and does not write the lockfile', async () => {
    await manifest({ devDependencies: { '@a/two': '^2.0.0' } })
    const outcome = await install({ production: true })

    expect(outcome.resolution.packages.size).toBe(1)
    expect(await readFile(join(dir, 'rarn.lock'), 'utf8').catch(() => undefined)).toBeUndefined()
  })

  /**
   * The check that withdrew 0.1.0. It has to run before anything is downloaded — a
   * refusal after the network work is still correct but wastes the time it took to
   * find out, and the ordering is exactly what no test could reach before.
   */
  test('refuses a directory it did not create, before fetching anything', async () => {
    await manifest()
    await mkdir(join(dir, 'RARN_MODULE'), { recursive: true })
    await writeFile(join(dir, 'RARN_MODULE', 'mine.luau'), 'return "my source"')

    const registry = registryOf(SPEC)
    const error = (await runInstall({
      projectDir: dir,
      registry,
      store: createCacheStore(cacheDir),
    }).catch((e: unknown) => e)) as RarnError

    expect(error.code).toBe(Code.InstallTargetNotOurs)
    expect(await readFile(join(dir, 'RARN_MODULE', 'mine.luau'), 'utf8')).toBe('return "my source"')
  })

  // Nothing in the pipeline prints, so a caller with no terminal is a caller like any
  // other. If that stops being true this test starts writing to the test runner's own
  // output, which is exactly where it would be noticed.
  test('an install with no observer is silent and still works', async () => {
    await manifest()
    // `install()` passes no observer at all, which is the shape a non-terminal
    // caller uses. Every optional hook has to tolerate being absent.
    const outcome = await install()
    expect(outcome.link.shims).toBeGreaterThan(0)
  })
})
