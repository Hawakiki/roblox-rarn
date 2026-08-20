import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafePackageDir } from '../src/linker/layout.ts'
import { link } from '../src/linker/link.ts'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import type { Placement, Resolution, ResolvedPackage } from '../src/resolver/types.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'
import { pathExists } from '../src/util/fs.ts'
import { parseWallyName } from '../src/util/package-name.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-link-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface PkgSpec {
  version?: string
  placement?: Placement
  deps?: Record<string, string>
  /** Files of the extracted archive, relative to its root. */
  files?: Record<string, string>
}

/**
 * Builds a resolution plus the extracted archives it refers to.
 *
 * The linker only needs a resolution and a directory per package, so the registry
 * and the cache are out of the picture here — these tests are about what lands on
 * disk, not about how the bytes got there.
 */
async function scenario(spec: Record<string, PkgSpec>) {
  const packages = new Map<string, ResolvedPackage>()
  const sources = new Map<string, string>()

  for (const [wallyName, pkg] of Object.entries(spec)) {
    const version = pkg.version ?? '1.0.0'
    const name = parseWallyName(wallyName)
    const key = `@${wallyName}@${version}`

    const source = join(dir, 'cache', `${name.scope}_${name.name}@${version}`)
    const files = pkg.files ?? { 'init.lua': `return { name = "${name.name}" }` }
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(source, path, '..'), { recursive: true })
      await writeFile(join(source, path), body)
    }
    sources.set(key, source)

    packages.set(key, {
      name,
      version,
      realm: pkg.placement === 'server' ? 'server' : 'shared',
      placement: pkg.placement ?? 'shared',
      dependencies: new Map(Object.entries(pkg.deps ?? {})),
      requestedBy: [{ from: 'root', range: '*', placement: pkg.placement ?? 'shared' }],
      dev: pkg.placement === 'dev',
      forcedBy: undefined,
    })
  }

  const resolution: Resolution = { packages, duplicates: new Map(), overrides: new Map() }
  return { resolution, sources }
}

async function run(spec: Record<string, PkgSpec>, manifest: Partial<Manifest>) {
  const project = join(dir, 'project')
  await mkdir(project, { recursive: true })
  const { resolution, sources } = await scenario(spec)
  const result = await link({
    projectDir: project,
    manifest: normalizeManifest({ name: 'game', version: '1.0.0', ...manifest }),
    resolution,
    sources,
  })
  return { project, result }
}

const shared = (p: string) => join(dir, 'project', 'RARN_MODULE', p)

async function expectRejection(fn: () => Promise<unknown>): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the call succeeded')
}

describe('layout safety', () => {
  // Installing deletes and rebuilds this directory, so a bad value here is not a
  // cosmetic problem. The schema's character class once permitted ".".
  test.each(['.', '..', '', '   ', 'a/b', 'a\\b'])('refuses packageDir %p', (value) => {
    expect(() => assertSafePackageDir('/project', value)).toThrow(RarnError)
  })

  test('accepts an ordinary directory name', () => {
    expect(assertSafePackageDir('/project', 'RARN_MODULE')).toBe('RARN_MODULE')
  })

  test('the refusal explains why, not just that', () => {
    const error = (() => {
      try {
        assertSafePackageDir('/project', '.')
        return undefined
      } catch (e) {
        return e as RarnError
      }
    })()
    expect(error?.how).toContain('never be the project root')
  })
})

describe('tree shape', () => {
  test('installs a package under _Index and shims it at the top level', async () => {
    await run(
      { 'evaera/promise': { version: '4.0.0' } },
      { dependencies: { '@evaera/promise': '^4.0.0' } },
    )

    expect(await pathExists(shared('Promise.luau'))).toBe(true)
    expect(await pathExists(shared('_Index/evaera_promise@4.0.0/promise/init.lua'))).toBe(true)
  })

  // The shims a package's own source reaches with script.Parent.Parent.Alias must sit
  // beside its module folder, or the require resolves to nothing.
  test('puts dependency shims beside the module folder, not inside it', async () => {
    await run(
      {
        'sleitnick/knit': { version: '1.7.0', deps: { Promise: '@evaera/promise@4.0.0' } },
        'evaera/promise': { version: '4.0.0' },
      },
      { dependencies: { '@sleitnick/knit': '^1.7.0' } },
    )

    expect(await pathExists(shared('_Index/sleitnick_knit@1.7.0/Promise.luau'))).toBe(true)
    expect(await pathExists(shared('_Index/sleitnick_knit@1.7.0/knit/Promise.luau'))).toBe(false)
  })

  test('names the dependency shim after the alias the package source uses', async () => {
    await run(
      { 'a/one': { deps: { WeirdName: '@a/two@1.0.0' } }, 'a/two': {} },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(await pathExists(shared('_Index/a_one@1.0.0/WeirdName.luau'))).toBe(true)
  })

  test('a single-file module installs as a file, not a directory', async () => {
    await run(
      {
        'red-blox/signal': {
          version: '2.0.2',
          files: {
            'default.project.json': JSON.stringify({
              name: 'signal',
              tree: { $path: 'Signal.luau' },
            }),
            'Signal.luau': 'return {}',
          },
        },
      },
      { dependencies: { '@red-blox/signal': '^2.0.2' } },
    )
    expect(await pathExists(shared('_Index/red-blox_signal@2.0.2/signal.luau'))).toBe(true)
  })

  test('reinstalling wipes what is no longer resolved', async () => {
    const project = join(dir, 'project')
    await mkdir(join(project, 'RARN_MODULE', '_Index', 'stale_pkg@9.9.9'), { recursive: true })
    await writeFile(join(project, 'RARN_MODULE', 'Stale.luau'), 'return 1')

    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })

    expect(await pathExists(shared('Stale.luau'))).toBe(false)
    expect(await pathExists(shared('_Index/stale_pkg@9.9.9'))).toBe(false)
  })

  test('leaves everything outside its own directories alone', async () => {
    const project = join(dir, 'project')
    await mkdir(join(project, 'src'), { recursive: true })
    await writeFile(join(project, 'src', 'main.luau'), 'mine')
    await writeFile(join(project, 'rarn.json'), '{}')

    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })

    expect(await readFile(join(project, 'src', 'main.luau'), 'utf8')).toBe('mine')
    expect(await pathExists(join(project, 'rarn.json'))).toBe(true)
  })
})

describe('shim contents', () => {
  test('a top-level shim reaches into _Index from the realm root', async () => {
    await run(
      { 'evaera/promise': { version: '4.0.0' } },
      { dependencies: { '@evaera/promise': '^4.0.0' } },
    )
    const source = await readFile(shared('Promise.luau'), 'utf8')
    expect(source).toContain('script.Parent._Index["evaera_promise@4.0.0"]["promise"]')
  })

  // script is the shim, script.Parent is the requester's entry, script.Parent.Parent
  // is _Index — from which any other entry is reachable.
  test('a dependency shim climbs two levels to _Index', async () => {
    await run(
      { 'a/one': { deps: { Two: '@a/two@1.0.0' } }, 'a/two': {} },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    const source = await readFile(shared('_Index/a_one@1.0.0/Two.luau'), 'utf8')
    expect(source).toContain('script.Parent.Parent["a_two@1.0.0"]["two"]')
  })

  // _Index entry names carry @ and .; package names may carry -. None of those are
  // valid after a dot in Luau.
  test('indexes with bracketed strings so punctuation cannot break the shim', async () => {
    await run(
      { 'red-blox/signal': { version: '2.0.2' } },
      { dependencies: { '@red-blox/signal': '^2.0.2' } },
    )
    const source = await readFile(shared('Signal.luau'), 'utf8')
    expect(source).toContain('["red-blox_signal@2.0.2"]')
    expect(source).not.toContain('.red-blox_signal')
  })

  test('marks generated files so they are not mistaken for package source', async () => {
    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(await readFile(shared('One.luau'), 'utf8')).toContain('Generated by Rarn')
  })

  test('an aliases override renames the top-level shim', async () => {
    await run(
      { 'a/promise': {} },
      {
        dependencies: { '@a/promise': '^1.0.0' },
        aliases: { '@a/promise': 'MyPromise' },
      },
    )
    expect(await pathExists(shared('MyPromise.luau'))).toBe(true)
    expect(await pathExists(shared('Promise.luau'))).toBe(false)
  })
})

describe('realms', () => {
  test('each realm gets its own sibling directory', async () => {
    await run(
      { 'a/client': {}, 'a/svc': { placement: 'server' }, 'a/test': { placement: 'dev' } },
      {
        dependencies: { '@a/client': '^1.0.0' },
        serverDependencies: { '@a/svc': '^1.0.0' },
        devDependencies: { '@a/test': '^1.0.0' },
      },
    )

    expect(await pathExists(join(dir, 'project', 'RARN_MODULE', 'Client.luau'))).toBe(true)
    expect(await pathExists(join(dir, 'project', 'RARN_MODULE_SERVER', 'Svc.luau'))).toBe(true)
    expect(await pathExists(join(dir, 'project', 'RARN_MODULE_DEV', 'Test.luau'))).toBe(true)
  })

  // Realm directories end up under different Roblox services, so no script.Parent
  // walk can cross between them.
  test('a cross-realm link uses the declared absolute path', async () => {
    await run(
      {
        'a/svc': { placement: 'server', deps: { Util: '@a/util@1.0.0' } },
        'a/util': { placement: 'shared' },
      },
      {
        serverDependencies: { '@a/svc': '^1.0.0' },
        place: { sharedPackages: 'game.ReplicatedStorage.Packages' },
      },
    )

    const source = await readFile(
      join(dir, 'project', 'RARN_MODULE_SERVER', '_Index', 'a_svc@1.0.0', 'Util.luau'),
      'utf8',
    )
    expect(source).toContain('game.ReplicatedStorage.Packages._Index["a_util@1.0.0"]["util"]')
  })

  test('a missing place path fails with the exact entry to add', async () => {
    const error = await expectRejection(() =>
      run(
        {
          'a/svc': { placement: 'server', deps: { Util: '@a/util@1.0.0' } },
          'a/util': { placement: 'shared' },
        },
        { serverDependencies: { '@a/svc': '^1.0.0' } },
      ),
    )

    expect(error.code).toBe(Code.MissingPlacePath)
    expect(error.detail).toContain('sharedPackages')
    expect(error.detail).toContain('game.ReplicatedStorage')
  })

  test('a package in two sections is shimmed from both realm directories', async () => {
    await run(
      { 'a/both': { placement: 'shared' } },
      {
        dependencies: { '@a/both': '^1.0.0' },
        devDependencies: { '@a/both': '^1.0.0' },
        place: { sharedPackages: 'game.ReplicatedStorage.Packages' },
      },
    )

    expect(await pathExists(join(dir, 'project', 'RARN_MODULE', 'Both.luau'))).toBe(true)
    expect(await pathExists(join(dir, 'project', 'RARN_MODULE_DEV', 'Both.luau'))).toBe(true)
    // Stored once, reachable twice.
    expect(await pathExists(join(dir, 'project', 'RARN_MODULE_DEV', '_Index'))).toBe(false)
  })
})

describe('collisions', () => {
  // Two instances of the same name in one parent means one wins and the other is
  // simply gone, with nothing to indicate it.
  test('refuses a dependency alias equal to the package module name', async () => {
    const error = await expectRejection(() =>
      run(
        { 'a/one': { deps: { one: '@a/two@1.0.0' } }, 'a/two': {} },
        { dependencies: { '@a/one': '^1.0.0' } },
      ),
    )
    expect(error.code).toBe(Code.AliasCollision)
  })
})

describe('reporting', () => {
  test('counts what pruning saved', async () => {
    const { result } = await run(
      {
        'a/one': {
          files: {
            'default.project.json': JSON.stringify({ name: 'one', tree: { $path: 'lib' } }),
            'lib/init.lua': 'return 1',
            'docs/a.md': 'x',
            'docs/b.md': 'x',
          },
        },
      },
      { dependencies: { '@a/one': '^1.0.0' } },
    )

    expect(result.archiveFiles).toBe(4)
    expect(result.installedFiles).toBe(1)
    expect(result.shims).toBe(1)
  })

  test('surfaces a project-file note without failing', async () => {
    const { result } = await run(
      { 'a/one': { files: { 'default.project.json': '{ broken', 'init.lua': 'return 1' } } },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(result.notes.get('@a/one@1.0.0')).toBeDefined()
  })

  test('reports only the realms that received something', async () => {
    const { result } = await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(result.usedRealms).toEqual(['shared'])
  })
})
