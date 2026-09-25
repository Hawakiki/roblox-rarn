import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockSchema from '../schemas/rarn.lock.schema.json' with { type: 'json' }
import manifestSchema from '../schemas/rarn.schema.json' with { type: 'json' }
import { checkFreshness } from '../src/lockfile/freshness.ts'
import { readLockfile, resolutionFromLockfile } from '../src/lockfile/read.ts'
import { LOCKFILE_VERSION } from '../src/lockfile/types.ts'
import { buildLockfile, serializeLockfile, writeLockfile } from '../src/lockfile/write.ts'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import { DEFAULT_API_URL } from '../src/registry/types.ts'
import type { Placement, Resolution, ResolvedPackage } from '../src/resolver/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { parseWallyName } from '../src/util/package-name.ts'
import { asIfLocale } from './locale.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-lock-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Spec {
  version?: string
  placement?: Placement
  deps?: Record<string, string>
  dev?: boolean
  requestedBy?: { from: string; range: string }[]
}

function resolutionOf(spec: Record<string, Spec>): Resolution {
  const packages = new Map<string, ResolvedPackage>()

  for (const [wallyName, pkg] of Object.entries(spec)) {
    const version = pkg.version ?? '1.0.0'
    const name = parseWallyName(wallyName)
    const placement = pkg.placement ?? 'shared'

    packages.set(`@${wallyName}@${version}`, {
      name,
      version,
      realm: placement === 'server' ? 'server' : 'shared',
      placement,
      dependencies: new Map(Object.entries(pkg.deps ?? {})),
      requestedBy: (pkg.requestedBy ?? [{ from: 'root', range: '*' }]).map((c) => ({
        ...c,
        placement,
      })),
      dev: pkg.dev ?? false,
      forcedBy: undefined,
    })
  }

  return { packages, duplicates: new Map(), overrides: new Map() }
}

function integrityOf(resolution: Resolution): Map<string, string> {
  return new Map(
    [...resolution.packages.keys()].map((key) => [key, `sha256-${btoa(key).slice(0, 40)}=`]),
  )
}

function build(spec: Record<string, Spec>, manifest: Partial<Manifest> = {}) {
  const resolution = resolutionOf(spec)
  return buildLockfile({
    manifest: normalizeManifest({ name: 'game', version: '1.0.0', ...manifest }),
    resolution,
    registry: DEFAULT_API_URL,
    integrity: integrityOf(resolution),
  })
}

describe('buildLockfile', () => {
  test('records everything needed to reproduce an install', () => {
    const lock = build(
      { 'evaera/promise': { version: '4.0.0' } },
      { dependencies: { '@evaera/promise': '^4.0.0' } },
    )
    const entry = lock.packages['@evaera/promise@4.0.0']

    expect(lock.lockfileVersion).toBe(LOCKFILE_VERSION)
    expect(entry?.version).toBe('4.0.0')
    expect(entry?.indexDir).toBe('evaera_promise@4.0.0')
    expect(entry?.integrity).toMatch(/^sha256-/)
    expect(entry?.resolved).toBe('https://api.wally.run/v1/package-contents/evaera/promise/4.0.0')
  })

  // Object key order in JSON is insertion order, so without sorting two identical
  // resolutions would still produce different bytes and every install would diff.
  test('sorts packages regardless of resolution order', () => {
    const forward = build({ 'a/zed': {}, 'a/alpha': {}, 'a/mid': {} })
    const reverse = build({ 'a/mid': {}, 'a/alpha': {}, 'a/zed': {} })
    expect(Object.keys(forward.packages)).toEqual(Object.keys(reverse.packages))
    expect(serializeLockfile(forward)).toBe(serializeLockfile(reverse))
  })

  test('sorts dependency aliases and requesters', () => {
    const lock = build({
      'a/one': { deps: { Zed: '@a/z@1.0.0', Alpha: '@a/a@1.0.0' } },
      'a/z': {},
      'a/a': {},
    })
    expect(Object.keys(lock.packages['@a/one@1.0.0']?.dependencies ?? {})).toEqual(['Alpha', 'Zed'])
  })

  // The `packages` map was already sorted by code unit and the maps inside it were not,
  // so one file followed two rules. Measured on a 619-package warm cache: of the 152
  // packages with two or more dependencies, vocksel/import@2.1.0 is the one where the
  // rules disagree, over `t` and `TestEZ`. An alias may also hold `-` and `_`, which
  // the two rules order oppositely.
  test('orders aliases by code unit, the rule the packages map already used', () => {
    const lock = build({
      'vocksel/import': {
        version: '2.1.0',
        deps: {
          t: '@osyrisrblx/t@3.0.0',
          Llama: '@freddylist/llama@1.1.1',
          TestEZ: '@roblox/testez@0.4.1',
        },
      },
      'a/one': { deps: { es7_types: '@a/x@1.0.0', 'es7-types': '@a/y@1.0.0' } },
    })

    expect(Object.keys(lock.packages['@vocksel/import@2.1.0']?.dependencies ?? {})).toEqual([
      'Llama',
      'TestEZ',
      't',
    ])
    expect(Object.keys(lock.packages['@a/one@1.0.0']?.dependencies ?? {})).toEqual([
      'es7-types',
      'es7_types',
    ])
  })

  // One requester, two ranges: a package declared in two manifest sections.
  test('orders the ranges of one requester by code unit', () => {
    const lock = build({
      'a/one': {
        requestedBy: [
          { from: 'root', range: '^1.0.0' },
          { from: 'root', range: '>=1.0.0 <2.0.0' },
        ],
      },
    })
    expect(lock.packages['@a/one@1.0.0']?.requestedBy?.map((c) => c.range)).toEqual([
      '>=1.0.0 <2.0.0',
      '^1.0.0',
    ])
  })

  // With no locale argument the collation is the machine's, and locales disagree about
  // plain ASCII: Czech sorts `ch` after `h`. The same install on a machine set to Czech
  // wrote a different rarn.lock from CI's, and every commit from it was a diff.
  test('writes the same bytes whatever the machine locale', async () => {
    const spec: Record<string, Spec> = {
      'acme/chalk': {},
      'acme/dog': {},
      'acme/shared': {
        requestedBy: [
          { from: '@acme/dog@1.0.0', range: '^1.0.0' },
          { from: '@acme/chalk@1.0.0', range: '^1.0.0' },
        ],
      },
    }
    const manifest = { dependencies: { '@acme/dog': '^1.0.0', '@acme/chalk': '^1.0.0' } }

    const here = serializeLockfile(build(spec, manifest))
    const there = await asIfLocale('cs', () => serializeLockfile(build(spec, manifest)))
    expect(there).toBe(here)
  })

  test('ends with a newline so the file is a well-formed text file', () => {
    expect(serializeLockfile(build({ 'a/one': {} })).endsWith('}\n')).toBe(true)
  })

  // Changing an override changes the resolution, so it has to be part of what the
  // freshness check compares.
  test('snapshots resolutions in root', () => {
    const lock = build(
      { 'a/one': { version: '2.0.0' } },
      { dependencies: { '@a/one': '^1.0.0' }, resolutions: { '@a/one': '2.0.0' } },
    )
    expect(lock.root.resolutions).toEqual({ '@a/one': '2.0.0' })
  })

  // Renaming a directory must not force a full re-resolution over the network.
  test('leaves out fields that only affect linking', () => {
    const lock = build(
      { 'a/one': {} },
      {
        dependencies: { '@a/one': '^1.0.0' },
        packageDir: 'Packages',
        aliases: { '@a/one': 'Renamed' },
        place: { sharedPackages: 'game.ReplicatedStorage.Packages' },
      },
    )
    const root = lock.root as Record<string, unknown>
    expect(root.packageDir).toBeUndefined()
    expect(root.aliases).toBeUndefined()
    expect(root.place).toBeUndefined()
  })

  test('refuses to write an entry with no integrity digest', () => {
    const resolution = resolutionOf({ 'a/one': {} })
    expect(() =>
      buildLockfile({
        manifest: normalizeManifest({ name: 'game', version: '1.0.0' }),
        resolution,
        registry: DEFAULT_API_URL,
        integrity: new Map(),
      }),
    ).toThrow(RarnError)
  })
})

describe('round trip', () => {
  // The trap this milestone exists to avoid: if reconstruction loses anything, a cold
  // install and a warm one produce different trees, and both report success.
  test('a resolution survives lockfile and back unchanged', () => {
    const spec: Record<string, Spec> = {
      'sleitnick/knit': { version: '1.7.0', deps: { Promise: '@evaera/promise@4.0.0' } },
      'evaera/promise': { version: '4.0.0' },
      'a/svc': { version: '1.0.0', placement: 'server' },
      'a/tool': { version: '1.0.0', placement: 'dev', dev: true },
    }
    const original = resolutionOf(spec)
    const lock = buildLockfile({
      manifest: normalizeManifest({ name: 'game', version: '1.0.0' }),
      resolution: original,
      registry: DEFAULT_API_URL,
      integrity: integrityOf(original),
    })

    const restored = resolutionFromLockfile(lock)

    expect([...restored.packages.keys()].sort()).toEqual([...original.packages.keys()].sort())
    for (const [key, before] of original.packages) {
      const after = restored.packages.get(key)
      expect(after?.name).toEqual(before.name)
      expect(after?.version).toBe(before.version)
      expect(after?.realm).toBe(before.realm)
      expect(after?.placement).toBe(before.placement)
      expect(after?.dev).toBe(before.dev)
      expect([...(after?.dependencies ?? [])].sort()).toEqual([...before.dependencies].sort())
      expect(after?.requestedBy.map((c) => c.from)).toEqual(before.requestedBy.map((c) => c.from))
    }
  })

  // If the second write differed, `git diff rarn.lock` would be dirty after an
  // install that changed nothing.
  test('rebuilding from a restored resolution produces identical bytes', () => {
    const spec: Record<string, Spec> = {
      'a/one': { deps: { Two: '@a/two@1.0.0' } },
      'a/two': {},
    }
    const manifest = normalizeManifest({
      name: 'game',
      version: '1.0.0',
      dependencies: { '@a/one': '^1.0.0' },
    })
    const resolution = resolutionOf(spec)
    const integrity = integrityOf(resolution)

    const first = buildLockfile({ manifest, resolution, registry: DEFAULT_API_URL, integrity })
    const second = buildLockfile({
      manifest,
      resolution: resolutionFromLockfile(first),
      registry: DEFAULT_API_URL,
      integrity,
    })

    expect(serializeLockfile(second)).toBe(serializeLockfile(first))
  })

  test('reports duplicates that were installed at two versions', () => {
    // Two majors of one package, which is legal — only same-major duplicates are a
    // problem. `resolutionOf` is keyed by name, so the two halves are merged here.
    const resolution: Resolution = {
      packages: new Map([
        ...resolutionOf({ 'a/dep': { version: '1.0.0' } }).packages,
        ...resolutionOf({ 'a/dep': { version: '2.0.0' } }).packages,
      ]),
      duplicates: new Map(),
      overrides: new Map(),
    }

    const lock = buildLockfile({
      manifest: normalizeManifest({ name: 'game', version: '1.0.0' }),
      resolution,
      registry: DEFAULT_API_URL,
      integrity: integrityOf(resolution),
    })

    const versions = [...(resolutionFromLockfile(lock).duplicates.get('@a/dep') ?? [])].sort()
    expect(versions).toEqual(['1.0.0', '2.0.0'])
  })
})

describe('readLockfile', () => {
  test('returns undefined when there is no lockfile', async () => {
    expect(await readLockfile(dir)).toBeUndefined()
  })

  test('reads back what was written', async () => {
    await writeLockfile(dir, build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }))
    const lock = await readLockfile(dir)
    expect(Object.keys(lock?.packages ?? {})).toEqual(['@a/one@1.0.0'])
  })

  test('reports bad JSON as bad JSON', async () => {
    await writeFile(join(dir, 'rarn.lock'), '{ oops')
    const error = await readLockfile(dir).catch((e: unknown) => e as RarnError)
    expect((error as RarnError).code).toBe(Code.LockfileInvalid)
  })

  test('rejects a lockfile that does not match the schema', async () => {
    await writeFile(join(dir, 'rarn.lock'), JSON.stringify({ lockfileVersion: 1 }))
    const error = await readLockfile(dir).catch((e: unknown) => e as RarnError)
    expect((error as RarnError).code).toBe(Code.LockfileInvalid)
  })

  // Deleting a newer lockfile would silently change the versions everyone else is
  // pinned to, so the advice has to be "upgrade Rarn", not "delete it".
  test('a newer lockfileVersion says to upgrade rather than delete', async () => {
    await writeFile(
      join(dir, 'rarn.lock'),
      JSON.stringify({ lockfileVersion: 99, registry: 'x', root: {}, packages: {} }),
    )
    const error = (await readLockfile(dir).catch((e: unknown) => e)) as RarnError
    expect(error.code).toBe(Code.LockfileTooNew)
    expect(error.how).toContain('Upgrade Rarn')
  })

  /** A lockfile Rarn wrote, with one package's `version` then edited to `version`. */
  async function writeWithVersion(version: string): Promise<void> {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    const locked = lock.packages['@a/one@1.0.0']
    if (locked === undefined) throw new Error('build() recorded no @a/one')
    await writeFile(
      join(dir, 'rarn.lock'),
      JSON.stringify({ ...lock, packages: { '@a/one@1.0.0': { ...locked, version } } }),
    )
  }

  // Reusing a lockfile goes around the registry and semver both, and `version` becomes
  // a folder name under _Index and in the cache. Each of these names some other folder,
  // or one semver would never have produced.
  test.each([
    '1.0.0/../../../../../ESCAPED',
    '1.0.0\\..\\..\\ESCAPED',
    '..',
    'C:ESCAPED',
    '1.0.0:stream',
    'v1.0.0',
    ' 1.0.0',
    '1.0',
    '0.0.0-001',
  ])('refuses a version of %p before anything reads it', async (version) => {
    await writeWithVersion(version)
    const error = (await readLockfile(dir).catch((e: unknown) => e)) as RarnError
    expect(error).toBeInstanceOf(RarnError)
    expect(error.code).toBe(Code.LockfileInvalid)
    expect(error.detail).toContain('/version')
  })

  // Build metadata is where a stricter rule would go wrong: `semver.valid` drops it, so
  // comparing against that refuses tazmondo/iris, vide and jecs — seven registry
  // versions (wally-index, 2026-09-25) that install today.
  test.each(['4.0.0', '4.0.0-rc.2', '2.5.2+89e7', '0.4.1+horse.0.1'])(
    'accepts %p',
    async (version) => {
      await writeWithVersion(version)
      expect((await readLockfile(dir))?.packages['@a/one@1.0.0']?.version).toBe(version)
    },
  )

  // Spelled out in both schemas so that each validates on its own. Every version a
  // manifest may pin in `resolutions` has to be one a lockfile can then hold.
  test('holds versions to the same rule as rarn.json', () => {
    expect(lockSchema.$defs.semver.pattern).toBe(manifestSchema.$defs.semver.pattern)
  })
})

describe('checkFreshness', () => {
  const manifest = (partial: Partial<Manifest>) =>
    normalizeManifest({ name: 'game', version: '1.0.0', ...partial })

  test('a lockfile matching the manifest is fresh', () => {
    const deps = { dependencies: { '@a/one': '^1.0.0' } }
    expect(checkFreshness(build({ 'a/one': {} }, deps), manifest(deps)).fresh).toBe(true)
  })

  test.each([
    ['a dependency added', { '@a/one': '^1.0.0', '@a/two': '^1.0.0' }],
    ['a dependency removed', {}],
    ['a range changed', { '@a/one': '^2.0.0' }],
  ])('is stale when %s', (_label, dependencies) => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    const result = checkFreshness(lock, manifest({ dependencies }))
    expect(result.fresh).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  // A reformatted manifest is not a changed manifest. Compared canonically, so
  // rewriting the notation does not force a refetch.
  test('an equivalent range written differently is still fresh', () => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(checkFreshness(lock, manifest({ dependencies: { '@a/one': '1.x' } })).fresh).toBe(true)
  })

  // Not the same requirement: ^1.0.0 excludes 2.0.0-rc.1 and >=1.0.0 <2.0.0 admits it.
  test('a range differing only in prerelease handling counts as a change', () => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    const result = checkFreshness(lock, manifest({ dependencies: { '@a/one': '>=1.0.0 <2.0.0' } }))
    expect(result.fresh).toBe(false)
  })

  // Changing an override changes the resolution. Missing that would keep installing
  // the version the user just overrode.
  test('is stale when a resolutions override changes', () => {
    const lock = build(
      { 'a/one': { version: '2.0.0' } },
      { dependencies: { '@a/one': '^1.0.0' }, resolutions: { '@a/one': '2.0.0' } },
    )
    const result = checkFreshness(
      lock,
      manifest({ dependencies: { '@a/one': '^1.0.0' }, resolutions: { '@a/one': '1.5.0' } }),
    )
    expect(result.fresh).toBe(false)
    expect(result.reasons.join(' ')).toContain('resolutions')
  })

  test('is stale when an override is removed entirely', () => {
    const lock = build(
      { 'a/one': { version: '2.0.0' } },
      { dependencies: { '@a/one': '^1.0.0' }, resolutions: { '@a/one': '2.0.0' } },
    )
    expect(checkFreshness(lock, manifest({ dependencies: { '@a/one': '^1.0.0' } })).fresh).toBe(
      false,
    )
  })

  test('is stale when the registry changes', () => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    const result = checkFreshness(
      lock,
      manifest({ dependencies: { '@a/one': '^1.0.0' }, registry: 'https://example.com/index' }),
    )
    expect(result.fresh).toBe(false)
    expect(result.reasons.join(' ')).toContain('registry')
  })

  // A hand-edited or half-written lockfile can pass every comparison and still be
  // missing entries.
  test('is stale when a declared package is absent from packages', () => {
    const lock = build({}, { dependencies: { '@a/ghost': '^1.0.0' } })
    const result = checkFreshness(lock, manifest({ dependencies: { '@a/ghost': '^1.0.0' } }))
    expect(result.fresh).toBe(false)
    expect(result.reasons.join(' ')).toContain('missing from the lockfile')
  })

  // These change where files land, not which versions are chosen, and linking runs
  // every install regardless.
  test.each([
    ['packageDir', { packageDir: 'Packages' }],
    ['aliases', { aliases: { '@a/one': 'Renamed' } }],
    ['place', { place: { sharedPackages: 'game.ReplicatedStorage.Packages' } }],
  ])('stays fresh when only %s changes', (_label, extra) => {
    const deps = { dependencies: { '@a/one': '^1.0.0' } }
    const lock = build({ 'a/one': {} }, deps)
    expect(checkFreshness(lock, manifest({ ...deps, ...extra })).fresh).toBe(true)
  })

  test('names every reason, not just the first', () => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    const result = checkFreshness(
      lock,
      manifest({ dependencies: { '@a/two': '^1.0.0' }, registry: 'https://example.com/i' }),
    )
    expect(result.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('file output', () => {
  test('writing twice produces identical bytes', async () => {
    const lock = build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    await writeLockfile(dir, lock)
    const first = await readFile(join(dir, 'rarn.lock'), 'utf8')
    await writeLockfile(dir, lock)
    expect(await readFile(join(dir, 'rarn.lock'), 'utf8')).toBe(first)
  })

  test('is readable JSON a person can review', async () => {
    await writeLockfile(dir, build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }))
    const text = await readFile(join(dir, 'rarn.lock'), 'utf8')
    expect(text).toContain('\n  "lockfileVersion": 1')
    expect(text.split('\n').length).toBeGreaterThan(5)
  })

  // A full disk mid-write. The lockfile is regenerable, but a torn one does not
  // regenerate itself: every install stops on a parse error until someone deletes it.
  test('a write that fails partway leaves the previous lockfile whole', async () => {
    await writeLockfile(dir, build({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }))
    const original = await readFile(join(dir, 'rarn.lock'), 'utf8')

    const real = fsp.writeFile
    const full = spyOn(fsp, 'writeFile').mockImplementation(
      async (...[target, data]: Parameters<typeof fsp.writeFile>) => {
        await real(target, (data as string).slice(0, 16), 'utf8')
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        })
      },
    )
    try {
      const next = build({ 'a/one': {}, 'a/two': {} }, { dependencies: { '@a/one': '^1.0.0' } })
      const error = await writeLockfile(dir, next).catch((e: unknown) => e)
      expect((error as RarnError).code).toBe(Code.LockfileInvalid)
      expect(full).toHaveBeenCalled()
    } finally {
      full.mockRestore()
    }

    expect(await readFile(join(dir, 'rarn.lock'), 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['rarn.lock'])
  })
})
