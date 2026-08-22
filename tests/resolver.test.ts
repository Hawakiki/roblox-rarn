import { describe, expect, test } from 'bun:test'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import type {
  PackageMetadata,
  PackageVersion,
  RegistryClient,
  SearchResult,
} from '../src/registry/types.ts'
import { resolve } from '../src/resolver/resolve.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { type PackageName, parseWallyName, toWallyName } from '../src/util/package-name.ts'
import { parsePackageReq } from '../src/util/version-range.ts'

/**
 * Builds a fake registry from a compact literal.
 *
 * `{ 'a/b': { '1.0.0': { Dep: 'c/d@^1.0.0' } } }` reads as one package at one version
 * with one dependency. Handwriting `PackageVersion` objects for every case would bury
 * the scenario under boilerplate, and the scenario is the part worth reading.
 */
type Spec = Record<string, Record<string, Record<string, string> | undefined>>

function registryOf(
  spec: Spec,
  opts: { realms?: Record<string, 'shared' | 'server'>; serverDeps?: Spec } = {},
): RegistryClient & { calls: string[] } {
  const calls: string[] = []

  const build = (name: string, version: string): PackageVersion => {
    const deps = new Map<string, ReturnType<typeof parsePackageReq>>()
    for (const [alias, req] of Object.entries(spec[name]?.[version] ?? {})) {
      deps.set(alias, parsePackageReq(req))
    }
    const serverDeps = new Map<string, ReturnType<typeof parsePackageReq>>()
    for (const [alias, req] of Object.entries(opts.serverDeps?.[name]?.[version] ?? {})) {
      serverDeps.set(alias, parsePackageReq(req))
    }
    return {
      name: parseWallyName(name),
      version,
      realm: opts.realms?.[name] ?? 'shared',
      dependencies: deps,
      serverDependencies: serverDeps,
      devDependencies: new Map(),
      place: {},
      description: undefined,
      license: undefined,
    }
  }

  return {
    calls,
    getMetadata(name: PackageName): Promise<PackageMetadata> {
      const key = toWallyName(name)
      calls.push(key)
      const versions = spec[key]
      if (versions === undefined) {
        return Promise.reject(
          new RarnError({ code: Code.PackageNotFound, what: `${key} not found.` }),
        )
      }
      return Promise.resolve({
        name,
        versions: Object.keys(versions)
          .sort()
          .reverse()
          .map((v) => build(key, v)),
      })
    },
    getContents(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array())
    },
    search(): Promise<readonly SearchResult[]> {
      return Promise.resolve([])
    },
    apiBase(): Promise<string> {
      return Promise.resolve('https://api.example/')
    },
    // The resolver never publishes. Reachable only through a mistake, so it says so.
    publish(): Promise<never> {
      return Promise.reject(new Error('the resolver must never publish'))
    },
  }
}

function manifestOf(partial: Partial<Manifest>) {
  return normalizeManifest({ name: 'game', version: '1.0.0', ...partial })
}

async function run(
  spec: Spec,
  partial: Partial<Manifest>,
  extra?: Parameters<typeof registryOf>[1],
) {
  const registry = registryOf(spec, extra)
  const result = await resolve({ manifest: manifestOf(partial), registry })
  return { result, registry }
}

/** `@scope/name@version` keys, sorted, for compact assertions. */
function keys(result: Awaited<ReturnType<typeof run>>['result']): string[] {
  return [...result.packages.keys()].sort()
}

describe('basic resolution', () => {
  test('resolves a single dependency to the newest matching version', async () => {
    const { result } = await run(
      { 'a/one': { '1.0.0': {}, '1.2.0': {}, '2.0.0': {} } },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(keys(result)).toEqual(['@a/one@1.2.0'])
  })

  test('follows transitive dependencies', async () => {
    const { result } = await run(
      {
        'a/one': { '1.0.0': { Two: 'a/two@^1.0.0' } },
        'a/two': { '1.0.0': { Three: 'a/three@^1.0.0' } },
        'a/three': { '1.0.0': {} },
      },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(keys(result)).toEqual(['@a/one@1.0.0', '@a/three@1.0.0', '@a/two@1.0.0'])
  })

  test('records the alias each dependency is required under', async () => {
    const { result } = await run(
      { 'a/one': { '1.0.0': { Promise: 'a/two@^1.0.0' } }, 'a/two': { '1.0.0': {} } },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(result.packages.get('@a/one@1.0.0')?.dependencies.get('Promise')).toBe('@a/two@1.0.0')
  })

  test('a package shared by two dependents resolves once', async () => {
    const { result } = await run(
      {
        'a/left': { '1.0.0': { Shared: 'a/shared@^1.0.0' } },
        'a/right': { '1.0.0': { Shared: 'a/shared@^1.0.0' } },
        'a/shared': { '1.0.0': {} },
      },
      { dependencies: { '@a/left': '^1.0.0', '@a/right': '^1.0.0' } },
    )
    expect(keys(result).filter((k) => k.startsWith('@a/shared'))).toEqual(['@a/shared@1.0.0'])
  })
})

describe('order independence — the case Wally fails', () => {
  // Wally activates whichever arrives first, then rejects every later 1.x candidate as
  // "compatible with something already chosen", and dies on a graph that has an answer.
  test('unifies ^1.2.0 and ^1.5.0 onto one version', async () => {
    const spec: Spec = {
      'a/left': { '1.0.0': { Dep: 'a/dep@^1.2.0' } },
      'a/right': { '1.0.0': { Dep: 'a/dep@^1.5.0' } },
      'a/dep': { '1.2.0': {}, '1.5.0': {}, '1.9.0': {}, '2.0.0': {} },
    }
    const { result } = await run(spec, {
      dependencies: { '@a/left': '^1.0.0', '@a/right': '^1.0.0' },
    })
    expect(keys(result).filter((k) => k.startsWith('@a/dep'))).toEqual(['@a/dep@1.9.0'])
  })

  // Same graph, dependencies declared the other way round. A greedy resolver's answer
  // depends on this; ours must not.
  test('produces the same answer with the requesters reversed', async () => {
    const spec: Spec = {
      'a/left': { '1.0.0': { Dep: 'a/dep@^1.2.0' } },
      'a/right': { '1.0.0': { Dep: 'a/dep@^1.5.0' } },
      'a/dep': { '1.2.0': {}, '1.5.0': {}, '1.9.0': {}, '2.0.0': {} },
    }
    const forward = await run(spec, {
      dependencies: { '@a/left': '^1.0.0', '@a/right': '^1.0.0' },
    })
    const reverse = await run(spec, {
      dependencies: { '@a/right': '^1.0.0', '@a/left': '^1.0.0' },
    })
    expect(keys(forward.result)).toEqual(keys(reverse.result))
  })

  test('three overlapping ranges still collapse to one version', async () => {
    const { result } = await run(
      {
        'a/x': { '1.0.0': { D: 'a/dep@>=1.0.0' } },
        'a/y': { '1.0.0': { D: 'a/dep@^1.3.0' } },
        'a/z': { '1.0.0': { D: 'a/dep@~1.7.0' } },
        'a/dep': { '1.0.0': {}, '1.3.0': {}, '1.7.0': {}, '1.7.5': {}, '1.9.0': {} },
      },
      { dependencies: { '@a/x': '^1.0.0', '@a/y': '^1.0.0', '@a/z': '^1.0.0' } },
    )
    expect(keys(result).filter((k) => k.startsWith('@a/dep'))).toEqual(['@a/dep@1.7.5'])
  })
})

describe('incompatible majors', () => {
  // Different majors are not interchangeable, so both are installed. That is allowed;
  // only same-major duplicates break singletons.
  test('installs both when ranges cannot unify', async () => {
    const { result } = await run(
      {
        'a/old': { '1.0.0': { Dep: 'a/dep@^1.0.0' } },
        'a/new': { '1.0.0': { Dep: 'a/dep@^2.0.0' } },
        'a/dep': { '1.0.0': {}, '2.0.0': {} },
      },
      { dependencies: { '@a/old': '^1.0.0', '@a/new': '^1.0.0' } },
    )
    expect(keys(result).filter((k) => k.startsWith('@a/dep'))).toEqual([
      '@a/dep@1.0.0',
      '@a/dep@2.0.0',
    ])
    expect(result.duplicates.get('@a/dep')).toEqual(['2.0.0', '1.0.0'])
  })

  // Each requester must link to the copy its own range allows, or it gets code that
  // does not match the API it was written against.
  test('each requester links to the version its range allows', async () => {
    const { result } = await run(
      {
        'a/old': { '1.0.0': { Dep: 'a/dep@^1.0.0' } },
        'a/new': { '1.0.0': { Dep: 'a/dep@^2.0.0' } },
        'a/dep': { '1.0.0': {}, '2.0.0': {} },
      },
      { dependencies: { '@a/old': '^1.0.0', '@a/new': '^1.0.0' } },
    )
    expect(result.packages.get('@a/old@1.0.0')?.dependencies.get('Dep')).toBe('@a/dep@1.0.0')
    expect(result.packages.get('@a/new@1.0.0')?.dependencies.get('Dep')).toBe('@a/dep@2.0.0')
  })

  test('0.x treats minor as the breaking axis', async () => {
    const { result } = await run(
      {
        'a/x': { '1.0.0': { D: 'a/dep@^0.2.0' } },
        'a/y': { '1.0.0': { D: 'a/dep@^0.3.0' } },
        'a/dep': { '0.2.0': {}, '0.3.0': {} },
      },
      { dependencies: { '@a/x': '^1.0.0', '@a/y': '^1.0.0' } },
    )
    expect(keys(result).filter((k) => k.startsWith('@a/dep'))).toHaveLength(2)
  })
})

describe('prereleases', () => {
  test('a plain range never picks a prerelease', async () => {
    const { result } = await run(
      { 'a/one': { '1.0.0': {}, '2.0.0-rc.1': {} } },
      { dependencies: { '@a/one': '*' } },
    )
    expect(keys(result)).toEqual(['@a/one@1.0.0'])
  })

  test('a range naming a prerelease can still reach it', async () => {
    const { result } = await run(
      { 'a/one': { '1.0.0': {}, '2.0.0-rc.1': {} } },
      { dependencies: { '@a/one': '>=2.0.0-rc.1' } },
    )
    expect(keys(result)).toEqual(['@a/one@2.0.0-rc.1'])
  })
})

describe('resolutions overrides', () => {
  // The escape hatch: two incompatible majors become one pinned version.
  test('forces one version and collapses a duplicate', async () => {
    const { result } = await run(
      {
        'a/old': { '1.0.0': { Dep: 'a/dep@^1.0.0' } },
        'a/new': { '1.0.0': { Dep: 'a/dep@^2.0.0' } },
        'a/dep': { '1.0.0': {}, '2.0.0': {} },
      },
      {
        dependencies: { '@a/old': '^1.0.0', '@a/new': '^1.0.0' },
        resolutions: { '@a/dep': '2.0.0' },
      },
    )
    expect(keys(result).filter((k) => k.startsWith('@a/dep'))).toEqual(['@a/dep@2.0.0'])
    expect(result.duplicates.size).toBe(0)
  })

  // A silent override would hide the very conflict the user needs to know about.
  test('reports which overrides were applied', async () => {
    const { result } = await run(
      { 'a/dep': { '1.0.0': {}, '2.0.0': {} } },
      { dependencies: { '@a/dep': '^1.0.0' }, resolutions: { '@a/dep': '2.0.0' } },
    )
    expect(result.overrides.get('@a/dep')).toBe('2.0.0')
    expect(result.packages.get('@a/dep@2.0.0')?.forcedBy).toBe('resolutions')
  })

  test('an override to a version that was never published fails', async () => {
    const error = (await run(
      { 'a/dep': { '1.0.0': {} } },
      { dependencies: { '@a/dep': '^1.0.0' }, resolutions: { '@a/dep': '9.9.9' } },
    ).catch((e: unknown) => e)) as RarnError
    expect(error).toBeInstanceOf(RarnError)
    expect(error.code).toBe(Code.UnresolvableRange)
  })
})

describe('realms and placement', () => {
  test('a server dependency is placed in server', async () => {
    const { result } = await run(
      { 'a/svc': { '1.0.0': {} } },
      { serverDependencies: { '@a/svc': '^1.0.0' } },
      { realms: { 'a/svc': 'server' } },
    )
    expect(result.packages.get('@a/svc@1.0.0')?.placement).toBe('server')
  })

  test('a dev-only dependency is marked dev', async () => {
    const { result } = await run(
      { 'a/test': { '1.0.0': {} } },
      { devDependencies: { '@a/test': '^1.0.0' } },
    )
    expect(result.packages.get('@a/test@1.0.0')?.dev).toBe(true)
  })

  // The widest requester wins: a package needed by shared code must be reachable there.
  test('shared wins over dev when both want the same package', async () => {
    const { result } = await run(
      { 'a/both': { '1.0.0': {} } },
      {
        dependencies: { '@a/both': '^1.0.0' },
        devDependencies: { '@a/both': '^1.0.0' },
      },
    )
    expect(result.packages.get('@a/both@1.0.0')?.placement).toBe('shared')
    expect(result.packages.get('@a/both@1.0.0')?.dev).toBe(false)
  })

  test('a shared package pulled in only by a server one is placed in server', async () => {
    const { result } = await run(
      { 'a/svc': { '1.0.0': { Util: 'a/util@^1.0.0' } }, 'a/util': { '1.0.0': {} } },
      { serverDependencies: { '@a/svc': '^1.0.0' } },
      { realms: { 'a/svc': 'server' } },
    )
    expect(result.packages.get('@a/util@1.0.0')?.placement).toBe('server')
  })

  // Shared code replicates to clients, which have no server-only code to find.
  test('rejects a shared package depending on a server one', async () => {
    const error = (await run(
      { 'a/lib': { '1.0.0': { Svc: 'a/svc@^1.0.0' } }, 'a/svc': { '1.0.0': {} } },
      { dependencies: { '@a/lib': '^1.0.0' } },
      { realms: { 'a/svc': 'server' } },
    ).catch((e: unknown) => e)) as RarnError

    expect(error.code).toBe(Code.RealmViolation)
    expect(error.how).toContain('replicates to clients')
  })

  test('production skips devDependencies entirely', async () => {
    const registry = registryOf({ 'a/keep': { '1.0.0': {} }, 'a/drop': { '1.0.0': {} } })
    const result = await resolve({
      manifest: manifestOf({
        dependencies: { '@a/keep': '^1.0.0' },
        devDependencies: { '@a/drop': '^1.0.0' },
      }),
      registry,
      production: true,
    })
    expect([...result.packages.keys()]).toEqual(['@a/keep@1.0.0'])
    expect(registry.calls).not.toContain('a/drop')
  })
})

describe('failure reporting', () => {
  test('names every requester and range when nothing satisfies them', async () => {
    const error = (await run(
      {
        'a/x': { '1.0.0': { D: 'a/dep@^5.0.0' } },
        'a/dep': { '1.0.0': {}, '2.0.0': {} },
      },
      { dependencies: { '@a/x': '^1.0.0' } },
    ).catch((e: unknown) => e)) as RarnError

    expect(error.code).toBe(Code.UnresolvableRange)
    expect(error.detail).toContain('^5.0.0')
    expect(error.detail).toContain('@a/x@1.0.0')
    // Showing what does exist turns "no" into something the user can act on.
    expect(error.detail).toContain('published:')
    expect(error.how).toContain('resolutions')
  })

  test('a direct dependency is labelled as coming from rarn.json', async () => {
    const error = (await run(
      { 'a/dep': { '1.0.0': {} } },
      { dependencies: { '@a/dep': '^9.0.0' } },
    ).catch((e: unknown) => e)) as RarnError
    expect(error.detail).toContain('rarn.json')
  })

  test('a missing package surfaces the registry error', async () => {
    const error = (await run({}, { dependencies: { '@a/ghost': '^1.0.0' } }).catch(
      (e: unknown) => e,
    )) as RarnError
    expect(error.code).toBe(Code.PackageNotFound)
  })
})

describe('graph shape', () => {
  test('a cycle terminates instead of looping forever', async () => {
    const { result } = await run(
      {
        'a/one': { '1.0.0': { Two: 'a/two@^1.0.0' } },
        'a/two': { '1.0.0': { One: 'a/one@^1.0.0' } },
      },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(keys(result)).toEqual(['@a/one@1.0.0', '@a/two@1.0.0'])
  })

  test('a diamond resolves the tip once', async () => {
    const { result } = await run(
      {
        'a/top': { '1.0.0': { L: 'a/left@^1.0.0', R: 'a/right@^1.0.0' } },
        'a/left': { '1.0.0': { B: 'a/base@^1.0.0' } },
        'a/right': { '1.0.0': { B: 'a/base@^1.0.0' } },
        'a/base': { '1.0.0': {} },
      },
      { dependencies: { '@a/top': '^1.0.0' } },
    )
    expect(keys(result)).toHaveLength(4)
  })

  // Metadata is cached per package, so a diamond must not refetch the tip.
  test('fetches each package once', async () => {
    const { registry } = await run(
      {
        'a/top': { '1.0.0': { L: 'a/left@^1.0.0', R: 'a/right@^1.0.0' } },
        'a/left': { '1.0.0': { B: 'a/base@^1.0.0' } },
        'a/right': { '1.0.0': { B: 'a/base@^1.0.0' } },
        'a/base': { '1.0.0': {} },
      },
      { dependencies: { '@a/top': '^1.0.0' } },
    )
    expect(registry.calls.filter((c) => c === 'a/base')).toHaveLength(1)
  })

  test('an empty manifest resolves to nothing', async () => {
    const { result } = await run({}, {})
    expect(result.packages.size).toBe(0)
  })
})

describe('reproducibility', () => {
  // The lockfile is only reproducible if this is.
  test('produces identical output across runs', async () => {
    const spec: Spec = {
      'a/top': { '1.0.0': { L: 'a/left@^1.0.0', R: 'a/right@^1.0.0' } },
      'a/left': { '1.0.0': { B: 'a/base@^1.2.0' } },
      'a/right': { '1.0.0': { B: 'a/base@^1.5.0' } },
      'a/base': { '1.2.0': {}, '1.5.0': {}, '1.9.0': {} },
    }
    const one = await run(spec, { dependencies: { '@a/top': '^1.0.0' } })
    const two = await run(spec, { dependencies: { '@a/top': '^1.0.0' } })
    expect(JSON.stringify([...one.result.packages])).toBe(JSON.stringify([...two.result.packages]))
  })

  test('requestedBy is recorded for every package', async () => {
    const { result } = await run(
      { 'a/one': { '1.0.0': { Two: 'a/two@^1.0.0' } }, 'a/two': { '1.0.0': {} } },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(result.packages.get('@a/one@1.0.0')?.requestedBy[0]?.from).toBe('root')
    expect(result.packages.get('@a/two@1.0.0')?.requestedBy[0]?.from).toBe('@a/one@1.0.0')
  })
})

/**
 * Two requesters on one major whose ranges do not intersect.
 *
 * Grouping puts them in separate groups, and merging them was unconditional: they
 * share a major, so the higher version was taken as a substitute for the lower. That
 * is semver's contract for a *caret* requirement and for nothing else — and until it
 * was checked, `~1.2.0` and `^1.5.0` silently produced `1.9.0` carrying `~1.2.0` as a
 * satisfied constraint. Constraint 5 says to report a conflict exactly when the
 * intersection is genuinely empty, and `semver.intersects` says it is.
 */
describe('a compatible-looking range that is not', () => {
  const registry: Spec = {
    'a/app': { '1.0.0': { Lib: 'a/lib@~1.2.0' } },
    'a/other': { '1.0.0': { Lib: 'a/lib@^1.5.0' } },
    'a/lib': { '1.9.0': {}, '1.5.0': {}, '1.2.0': {} },
  }

  test('is a conflict, not a silent upgrade', async () => {
    const error = (await run(registry, {
      dependencies: { '@a/app': '^1.0.0', '@a/other': '^1.0.0' },
    }).catch((e: unknown) => e)) as RarnError

    expect(error.code).toBe(Code.UnresolvableRange)
    // Both requesters are named, so the reader can see which two disagree.
    expect(error.detail).toContain('~1.2.0')
  })

  test('the same pair in the other order fails the same way', async () => {
    const error = (await run(registry, {
      dependencies: { '@a/other': '^1.0.0', '@a/app': '^1.0.0' },
    }).catch((e: unknown) => e)) as RarnError
    expect(error.code).toBe(Code.UnresolvableRange)
  })

  // The control. Carets *are* substitutable upward, and merging them is the whole
  // reason resolution is order-independent — breaking that would be a worse bug than
  // the one being fixed.
  test('two carets on one major still merge to one version', async () => {
    const { result } = await run(
      {
        'a/app': { '1.0.0': { Lib: 'a/lib@^1.2.0' } },
        'a/other': { '1.0.0': { Lib: 'a/lib@^1.5.0' } },
        'a/lib': { '1.9.0': {}, '1.5.0': {}, '1.2.0': {} },
      },
      { dependencies: { '@a/app': '^1.0.0', '@a/other': '^1.0.0' } },
    )

    expect([...result.packages.keys()].filter((k) => k.startsWith('@a/lib'))).toEqual([
      '@a/lib@1.9.0',
    ])
    expect(result.duplicates.size).toBe(0)
  })

  // Tildes that do overlap must still collapse. The fix must not turn every `~` into
  // a conflict.
  test('two overlapping tildes merge', async () => {
    const { result } = await run(
      {
        'a/app': { '1.0.0': { Lib: 'a/lib@~1.2.0' } },
        'a/other': { '1.0.0': { Lib: 'a/lib@~1.2.3' } },
        'a/lib': { '1.2.5': {}, '1.2.3': {}, '1.2.0': {} },
      },
      { dependencies: { '@a/app': '^1.0.0', '@a/other': '^1.0.0' } },
    )
    expect([...result.packages.keys()].filter((k) => k.startsWith('@a/lib'))).toEqual([
      '@a/lib@1.2.5',
    ])
  })

  // Different majors are a legitimate duplicate, not a conflict — the one case where
  // two versions of a package may coexist.
  test('different majors still coexist', async () => {
    const { result } = await run(
      {
        'a/app': { '1.0.0': { Lib: 'a/lib@^1.0.0' } },
        'a/other': { '1.0.0': { Lib: 'a/lib@^2.0.0' } },
        'a/lib': { '2.1.0': {}, '1.9.0': {} },
      },
      { dependencies: { '@a/app': '^1.0.0', '@a/other': '^1.0.0' } },
    )
    expect(result.duplicates.get('@a/lib')).toEqual(['2.1.0', '1.9.0'])
  })
})
