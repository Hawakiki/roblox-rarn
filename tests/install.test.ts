import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { zipSync } from 'fflate'
import { computeIntegrity } from '../src/cache/integrity.ts'
import { cacheKey, downloadPath } from '../src/cache/paths.ts'
import { createCacheStore } from '../src/cache/store.ts'
import { install as installCommand } from '../src/cli/commands/install.ts'
import { runInstall } from '../src/install/run.ts'
import { createRegistryClient } from '../src/registry/client.ts'
import type {
  PackageMetadata,
  PackageVersion,
  RegistryClient,
  SearchResult,
  WireVersion,
} from '../src/registry/types.ts'
import { Code, WarnCode } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { pathExists } from '../src/util/fs.ts'
import { blockNetwork, unblockNetwork } from '../src/util/network.ts'
import { type PackageName, parseWallyName, toWallyName } from '../src/util/package-name.ts'

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
   * Lockfiles written before the order was fixed hold the same facts in another order.
   * Freshness compares facts, so such a file is reused offline and `--frozen-lockfile`
   * accepts it; the rewrite at the end of that install is the only thing that changes.
   * A freshness check that ever compared text would fail every CI run on upgrade.
   */
  test('a lockfile in another key order is fresh, and is rewritten in code-unit order', async () => {
    await manifest({ dependencies: { '@a/one': '^1.0.0', '@a/two': '^2.0.0' } })
    await install()
    const written = await readFile(join(dir, 'rarn.lock'), 'utf8')

    const lock = JSON.parse(written) as { root: { dependencies: Record<string, string> } }
    lock.root.dependencies = Object.fromEntries(Object.entries(lock.root.dependencies).reverse())
    const reordered = `${JSON.stringify(lock, null, 2)}\n`
    expect(reordered).not.toBe(written)
    await writeFile(join(dir, 'rarn.lock'), reordered)

    const registry = registryOf(SPEC)
    const outcome = await install({ registry, frozenLockfile: true })

    expect(outcome.fromLockfile).toBe(true)
    expect(registry.metadataCalls).toBe(0)
    expect(await readFile(join(dir, 'rarn.lock'), 'utf8')).toBe(written)
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

/**
 * The store decides what a damaged cache entry means. These hold the pipeline to
 * carrying that decision out to where a person will read it.
 */
describe('a damaged cache under a fresh lockfile', () => {
  const cachedArchive = () => downloadPath(cacheDir, cacheKey(parseWallyName('a/one'), '1.0.0'))
  const damage = new TextEncoder().encode('not the pinned bytes')

  test('is downloaded again, and the repair is reported', async () => {
    await manifest()
    await install()
    await writeFile(cachedArchive(), damage)

    const outcome = await install()

    expect(outcome.fromLockfile).toBe(true)
    expect(outcome.downloaded).toBe(1)
    expect(outcome.repairedCache).toEqual([
      { key: '@a/one@1.0.0', discarded: computeIntegrity(damage) },
    ])
    expect(
      await readFile(join(dir, 'RARN_MODULE', '_Index', 'a_one@1.0.0', 'one', 'init.luau'), 'utf8'),
    ).toBe('return {}')
  })

  // The outcome carrying it is not the same as anyone seeing it: the summary is the
  // only place a person learns the shared cache held bytes nobody pinned.
  test('the repair reaches the printed summary, with its code', async () => {
    await manifest()
    await install()
    await writeFile(cachedArchive(), damage)

    const previousCacheDir = process.env.RARN_CACHE_DIR
    process.env.RARN_CACHE_DIR = cacheDir
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }
    try {
      await installCommand({ cwd: dir }, registryOf(SPEC))
    } finally {
      process.stdout.write = original
      // `Reflect.deleteProperty`, for the reason `registry.test.ts` gives at its own
      // restore: assigning undefined to an env var stores the string "undefined".
      if (previousCacheDir === undefined) Reflect.deleteProperty(process.env, 'RARN_CACHE_DIR')
      else process.env.RARN_CACHE_DIR = previousCacheDir
    }

    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
    const summary = written.join('').replaceAll(ansi, '')
    expect(summary).toContain(`${WarnCode.CacheEntryReplaced} @a/one@1.0.0`)
    // The one value that can find another rarn.lock that recorded those bytes.
    expect(summary).toContain(`discarded ${computeIntegrity(damage)}`)
  })

  // The real client behind the real guard, because `--offline` is what someone with a
  // damaged cache on a train actually runs — and it has to end at RN0130, not at a
  // registry that was never asked.
  test('offline, stops at RN0130 and says the cached copy disagreed with rarn.lock', async () => {
    await manifest()
    await install()
    await writeFile(cachedArchive(), damage)

    blockNetwork()
    let error: unknown
    try {
      error = await install({ registry: createRegistryClient() }).catch((e: unknown) => e)
    } finally {
      unblockNetwork()
    }

    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(Code.NetworkBlocked)
    expect((error as RarnError).what).toContain('cached copy')
    expect((error as RarnError).format()).not.toContain('registry served')
  })
})

/**
 * A registry reached over the wire, so metadata goes through the real parser.
 *
 * `registryOf` above hands the resolver parsed metadata directly, which skips the one
 * layer that decides whether a published document can be trusted.
 */
function wireRegistry(packages: Record<string, WireVersion[]>): RegistryClient {
  const handler = (input: string | URL | Request): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    const metadata = /^\/v1\/package-metadata\/(.+)$/.exec(path)?.[1]
    const versions = metadata === undefined ? undefined : packages[metadata]
    if (versions !== undefined) return Promise.resolve(Response.json({ versions }))

    const contents = /^\/v1\/package-contents\/[^/]+\/([^/]+)\//.exec(path)?.[1]
    if (contents !== undefined) return Promise.resolve(new Response(archiveOf(contents)))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
  return createRegistryClient({
    apiUrl: 'https://api.example/',
    attempts: 1,
    fetch: handler as unknown as typeof globalThis.fetch,
  })
}

function wireVersion(name: string, dependencies: Record<string, string> = {}): WireVersion {
  return { package: { name, version: '1.0.0', realm: 'shared' }, dependencies }
}

describe('a dependency alias from the registry', () => {
  // Wally's registry stores whatever key a published wally.toml gave a dependency, and
  // the linker names a file after it. Four levels up from the staged _Index entry is
  // the project itself, so this one lands on the user's own source.
  test('cannot name a file outside the install', async () => {
    const main = join(dir, 'src', 'Main.luau')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(main, '-- my code\n')
    await manifest({ dependencies: { '@evil/pkg': '^1.0.0' } })

    const registry = wireRegistry({
      'evil/pkg': [wireVersion('evil/pkg', { '../../../../src/Main': 'a/one@>=1.0.0, <2.0.0' })],
      'a/one': [wireVersion('a/one')],
    })
    const error = await install({ registry }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(await readFile(main, 'utf8')).toBe('-- my code\n')
    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(Code.UnsafeDependencyAlias)
    expect((error as RarnError).where).toBe('evil/pkg@1.0.0')
    // Refused while reading metadata, so nothing was downloaded or staged either.
    expect(await pathExists(join(dir, 'RARN_MODULE'))).toBe(false)
    expect(await pathExists(join(dir, 'rarn.lock'))).toBe(false)
  })
})

/** Every file under `root`, relative to it and with forward slashes. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
}

describe('a version from rarn.lock', () => {
  // A committed rarn.lock is repository content, and reusing one skips both the registry
  // and semver. Its `version` becomes a folder name under _Index and in the cache, and
  // five levels up from either is somewhere neither owns. The lockfile's own `integrity`
  // can hold the real archive's digest, so a pull request touching rarn.lock alone is
  // enough.
  //
  // Writing there is the lesser harm. When that directory already exists and has no
  // `.zip` beside it, the cache takes it for an entry it cannot verify and deletes it
  // recursively before downloading anything, then unpacks the package in its place.
  test('cannot name a directory outside the project or the cache', async () => {
    const project = join(dir, 'p1', 'p2', 'p3', 'project')
    const cache = join(dir, 'c1', 'c2', 'c3', 'c4', 'cache')
    await mkdir(project, { recursive: true })
    await writeFile(
      join(project, 'rarn.json'),
      JSON.stringify({ name: '@me/game', version: '1.0.0', dependencies: { '@a/one': '^1.0.0' } }),
    )
    const installHere = () =>
      runInstall({
        projectDir: project,
        registry: registryOf(SPEC),
        store: createCacheStore(cache),
      })
    await installHere()

    const lockPath = join(project, 'rarn.lock')
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      packages: Record<string, { version: string }>
    }
    const locked = lock.packages['@a/one@1.0.0']
    if (locked === undefined) throw new Error('the first install recorded no @a/one')
    locked.version = '1.0.0/../../../../../ESCAPED'
    await writeFile(lockPath, JSON.stringify(lock, null, 2))
    // Where that version lands, counting up from cache/extracted/a_one@….
    await mkdir(join(dir, 'c1', 'c2', 'ESCAPED'))
    await writeFile(join(dir, 'c1', 'c2', 'ESCAPED', 'precious.txt'), 'not the cache')

    const error = await installHere().then(
      () => undefined,
      (e: unknown) => e,
    )

    const outside = (await filesUnder(dir)).filter(
      (path) => !path.startsWith('p1/p2/p3/project/') && !path.startsWith('c1/c2/c3/c4/cache/'),
    )
    expect(outside).toEqual(['c1/c2/ESCAPED/precious.txt'])
    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(Code.LockfileInvalid)
    expect((error as RarnError).detail).toContain('/version')
  })

  // The rule is the registry parser's as much as the schema's. If the parser admitted a
  // version the schema refused, install would write a lockfile it could not read back —
  // which is how a too-narrow alias pattern once broke every react-lua install. Build
  // metadata is the case a tighter rule would lose: tazmondo/iris publishes 2.5.2+89e7.
  test('carrying build metadata, still reads back', async () => {
    await manifest()
    const registry = wireRegistry({
      'a/one': [{ package: { name: 'a/one', version: '1.0.0+89e7', realm: 'shared' } }],
    })
    await install({ registry })
    const again = await install({ registry })

    expect(again.fromLockfile).toBe(true)
    expect([...again.resolution.packages.keys()]).toEqual(['@a/one@1.0.0+89e7'])
    expect(await pathExists(join(dir, 'RARN_MODULE', '_Index', 'a_one@1.0.0+89e7', 'one'))).toBe(
      true,
    )
  })
})
