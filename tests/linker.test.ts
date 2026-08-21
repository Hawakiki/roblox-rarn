import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

describe('install atomicity', () => {
  const project = () => join(dir, 'project')

  /** Links into the same project a second time, so the swap has a tree to replace. */
  async function relink(spec: Record<string, PkgSpec>, manifest: Partial<Manifest> = {}) {
    const { resolution, sources } = await scenario(spec)
    return await link({
      projectDir: project(),
      manifest: normalizeManifest({ name: 'game', version: '1.0.0', ...manifest }),
      resolution,
      sources,
    })
  }

  test('leaves nothing staged behind on success', async () => {
    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })

    const left = (await readdir(project())).filter(
      (entry) => entry.startsWith('.rarn-tmp') || entry.startsWith('.rarn-old-'),
    )
    expect(left).toEqual([])
  })

  // The reason the staging directory exists. Before it, this test's project would be
  // left with no tree at all — the delete had already happened.
  test('a failure partway through leaves the previous tree untouched', async () => {
    await run(
      { 'a/one': { files: { 'init.lua': 'return "first"' } } },
      { dependencies: { '@a/one': '^1.0.0' } },
    )
    expect(await readFile(shared('_Index/a_one@1.0.0/one/init.lua'), 'utf8')).toBe('return "first"')

    // A resolution naming a package with no downloaded source. The linker discovers
    // this while writing, which is exactly the moment that used to be unrecoverable.
    const { resolution } = await scenario({ 'a/one': {}, 'b/two': {} })
    const { sources } = await scenario({ 'a/one': {} })

    await expectRejection(() =>
      link({
        projectDir: project(),
        manifest: normalizeManifest({
          name: 'game',
          version: '1.0.0',
          dependencies: { '@a/one': '^1.0.0', '@b/two': '^1.0.0' },
        }),
        resolution,
        sources,
      }),
    )

    expect(await readFile(shared('_Index/a_one@1.0.0/one/init.lua'), 'utf8')).toBe('return "first"')
    expect(await pathExists(join(project(), '.rarn-tmp'))).toBe(false)
  })

  test('replaces the previous tree rather than merging into it', async () => {
    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(await pathExists(shared('_Index/a_one@1.0.0'))).toBe(true)

    await relink({ 'b/two': {} }, { dependencies: { '@b/two': '^1.0.0' } })

    // A stale entry that still resolves is worse than a missing one: it keeps working
    // until the day two copies of something disagree.
    expect(await pathExists(shared('_Index/a_one@1.0.0'))).toBe(false)
    expect(await pathExists(shared('_Index/b_two@1.0.0'))).toBe(true)
  })

  // A realm nothing is placed into is not rebuilt, so it has to be retired instead —
  // otherwise dropping the last server dependency leaves the old server tree behind.
  test('a realm that is no longer used is removed', async () => {
    await run({ 'a/one': { placement: 'server' } }, { serverDependencies: { '@a/one': '^1.0.0' } })
    expect(await pathExists(join(project(), 'RARN_MODULE_SERVER'))).toBe(true)

    await relink({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(await pathExists(join(project(), 'RARN_MODULE_SERVER'))).toBe(false)
  })

  test('clears what an interrupted run left behind', async () => {
    await mkdir(join(dir, 'project'), { recursive: true })
    await mkdir(join(project(), '.rarn-tmp', 'RARN_MODULE'), { recursive: true })
    await mkdir(join(project(), '.rarn-old-deadbeef'), { recursive: true })

    await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })

    expect(await pathExists(join(project(), '.rarn-tmp'))).toBe(false)
    expect(await pathExists(join(project(), '.rarn-old-deadbeef'))).toBe(false)
  })
})

describe('install ownership', () => {
  const project = () => join(dir, 'project')

  async function seed(realmDir: string, files: Record<string, string>) {
    for (const [path, body] of Object.entries(files)) {
      const full = join(project(), realmDir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, body)
    }
  }

  /**
   * The failure that withdrew 0.1.0.
   *
   * `rarn import` writes `packageDir: "Packages"`, Windows and macOS ignore case, and
   * a monorepo's `packages/` source directory was therefore the install target. The
   * install succeeded and printed a success line.
   */
  test('refuses to install over a directory holding something else', async () => {
    await mkdir(project(), { recursive: true })
    await seed('RARN_MODULE', { 'my-lib/init.luau': 'return { mine = true }' })

    const error = await expectRejection(() =>
      run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }),
    )

    expect(error.code).toBe(Code.InstallTargetNotOurs)
    expect(error.detail).toContain('my-lib')
    // The source survives. This is the whole point.
    expect(await pathExists(join(project(), 'RARN_MODULE', 'my-lib', 'init.luau'))).toBe(true)
  })

  // A Wally install is ours to replace — that is what migrating means. The test that
  // matters is that this stays allowed while the one above stays refused.
  test('replaces an existing package install, ours or Wally’s', async () => {
    await mkdir(project(), { recursive: true })
    await seed('RARN_MODULE', {
      'Promise.lua': 'return require(script.Parent._Index["evaera_promise@4.0.0"]["promise"])',
      '_Index/evaera_promise@4.0.0/promise/init.lua': 'return {}',
    })

    const { result } = await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(result.usedRealms).toContain('shared')
    expect(await pathExists(shared('_Index/a_one@1.0.0'))).toBe(true)
  })

  test('an empty directory is not somebody else’s', async () => {
    await mkdir(join(project(), 'RARN_MODULE'), { recursive: true })
    const { result } = await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(result.shims).toBeGreaterThan(0)
  })

  // A realm with only root shims and no `_Index` has no marker directory to go by,
  // so the header is what identifies it.
  test('a directory of generated shims is ours', async () => {
    await mkdir(project(), { recursive: true })
    await seed('RARN_MODULE', {
      'Old.luau': '-- Generated by Rarn. Do not edit; reinstalling overwrites this file.\nreturn 1',
    })
    const { result } = await run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } })
    expect(result.shims).toBeGreaterThan(0)
  })

  test('a hand-written .luau file is not', async () => {
    await mkdir(project(), { recursive: true })
    await seed('RARN_MODULE', { 'Mine.luau': 'return { handwritten = true }' })

    const error = await expectRejection(() =>
      run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }),
    )
    expect(error.code).toBe(Code.InstallTargetNotOurs)
    expect(error.detail).toContain('Mine.luau')
  })

  // Refusing has to happen before the work, not at swap time: the user should not
  // wait through a download to be told something knowable up front.
  test('refuses before staging anything', async () => {
    await mkdir(project(), { recursive: true })
    await seed('RARN_MODULE', { 'src/thing.luau': 'return 1' })

    await expectRejection(() => run({ 'a/one': {} }, { dependencies: { '@a/one': '^1.0.0' } }))
    expect(await pathExists(join(project(), '.rarn-tmp'))).toBe(false)
  })
})
