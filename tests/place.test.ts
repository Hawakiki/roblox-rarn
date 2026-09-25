import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import { resolvePlace, scanPlaceProject, unmountedRealms } from '../src/project/place.ts'
import { asIfLocale } from './locale.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-place-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function project(tree: unknown, manifest: Partial<Manifest> = {}) {
  if (tree !== undefined) {
    await writeFile(
      join(dir, 'default.project.json'),
      typeof tree === 'string' ? tree : JSON.stringify({ name: 'game', tree }, null, 2),
    )
  }
  return normalizeManifest({ name: '@me/game', version: '1.0.0', ...manifest })
}

describe('scanPlaceProject', () => {
  /**
   * The shape a Roblox game template actually ships with.
   *
   * Taken from a real project rather than invented — note that `ReplicatedStorage`
   * carries no `$className`, which an invented fixture would have included and which
   * a scanner requiring one would silently skip.
   */
  test('finds the shared realm under a service with no $className', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: {
          Packages: { $path: 'Packages' },
          Client: { $path: 'src/Client' },
        },
        ServerScriptService: { Server: { $path: 'src/Server' } },
      },
      { packageDir: 'Packages' },
    )

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.scanned).toBe(true)
    expect(scan.found.get('Packages')).toBe('game.ReplicatedStorage.Packages')
  })

  // The DataModel name and the folder name are not the same thing, which is the whole
  // reason this cannot be guessed from `packageDir`. Real project, real mismatch.
  test('reports the DataModel name, not the folder name', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: {
          $className: 'ReplicatedStorage',
          SharedPackages: { $path: { optional: 'Packages' } },
        },
        ServerScriptService: {
          $className: 'ServerScriptService',
          ServerPackages: { $path: { optional: 'Packages_SERVER' } },
        },
      },
      { packageDir: 'Packages' },
    )

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.found.get('Packages')).toBe('game.ReplicatedStorage.SharedPackages')
    expect(scan.found.get('Packages_SERVER')).toBe('game.ServerScriptService.ServerPackages')
  })

  // `{ "optional": "Packages" }` is how a project says the folder may not exist yet —
  // which is exactly what a project using a package manager writes.
  test('reads the optional form of $path', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: { Packages: { $path: { optional: 'Packages' } } },
      },
      { packageDir: 'Packages' },
    )
    expect((await scanPlaceProject(dir, manifest)).found.get('Packages')).toBe(
      'game.ReplicatedStorage.Packages',
    )
  })

  // A node can carry `$path` and children at once. Stopping at the first `$path`
  // would miss anything below it.
  test('descends through a node that has both $path and children', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: {
            $path: 'src/shared',
            Packages: { $path: 'Packages' },
          },
        },
      },
      { packageDir: 'Packages' },
    )
    expect((await scanPlaceProject(dir, manifest)).found.get('Packages')).toBe(
      'game.ReplicatedStorage.Shared.Packages',
    )
  })

  test('normalizes ./ and backslashes', async () => {
    const manifest = await project(
      { $className: 'DataModel', ReplicatedStorage: { Packages: { $path: './Packages' } } },
      { packageDir: 'Packages' },
    )
    expect((await scanPlaceProject(dir, manifest)).found.get('Packages')).toBe(
      'game.ReplicatedStorage.Packages',
    )
  })

  /**
   * A library's project file is `{ "tree": { "$path": "src" } }`. Walking it finds
   * nothing, and that is correct — but it was also treated as *unscanned*, which
   * silenced the unmounted-realm warning in the shape every publishable package uses.
   * The two are separate facts: nothing was found, and a project file was read.
   */
  test('a library project file is read, even though it mounts nothing', async () => {
    const manifest = await project({ $path: 'src' })
    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.scanned).toBe(true)
    expect(scan.found.size).toBe(0)
    expect(scan.notes).toEqual([])
  })

  test('no project file is silent, not a note', async () => {
    const manifest = await project(undefined)
    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.scanned).toBe(false)
    expect(scan.notes).toEqual([])
  })

  test('unparseable JSON produces a note and no mapping', async () => {
    const manifest = await project('{ not json')
    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.found.size).toBe(0)
    expect(scan.notes.join('\n')).toContain('valid JSON')
  })

  // Two mounts of one folder means two copies of every package in it at runtime —
  // the duplication the whole `_Index` layout exists to prevent.
  test('a realm mounted twice is reported', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: { Packages: { $path: 'Packages' } },
        StarterPlayer: { StarterPlayerScripts: { Copy: { $path: 'Packages' } } },
      },
      { packageDir: 'Packages' },
    )
    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.notes.join('\n')).toContain('default.project.json mounts Packages/ at both')
  })

  test('a directory that is not a realm is ignored', async () => {
    const manifest = await project({
      $className: 'DataModel',
      ReplicatedStorage: { Models: { $path: 'models' } },
    })
    expect((await scanPlaceProject(dir, manifest)).found.size).toBe(0)
  })
})

/**
 * The shapes a fixed `default.project.json` lookup could not see.
 *
 * Of the multi-place repositories surveyed for R2, 25 of 30 have no
 * `default.project.json` at the root — the file is named per place, or nested one
 * directory per place. Those are the projects with a cross-realm link to derive, and
 * they were the ones the scan returned nothing for.
 */
describe('scanPlaceProject across project files', () => {
  async function write(path: string, tree: unknown) {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, JSON.stringify({ name: 'place', tree }, null, 2))
  }

  test('reads a project file that is not named default', async () => {
    await write('client.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: 'RARN_MODULE' } },
    })
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.scanned).toBe(true)
    expect(scan.found.get('RARN_MODULE')).toBe('game.ReplicatedStorage.Packages')
  })

  /**
   * `places/lobby/default.project.json` reaches a realm directory at the repository
   * root as `../../RARN_MODULE`. Comparing the literal string against the realm name
   * matched only a file sitting at the root, which is the arrangement these repos
   * do not use.
   */
  test('resolves $path against the project file, not the project root', async () => {
    await write('places/lobby/default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: '../../RARN_MODULE' } },
    })
    const manifest = await project(undefined)

    expect((await scanPlaceProject(dir, manifest)).found.get('RARN_MODULE')).toBe(
      'game.ReplicatedStorage.Packages',
    )
  })

  // Measured for R2: 12 of 12 multi-place repositories that mount a dependency
  // directory mount it at the same DataModel path in every place. Agreement is the
  // normal case and must not read as a conflict.
  test('two places agreeing on one path derive it without a note', async () => {
    const tree = {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: '../../RARN_MODULE' } },
    }
    await write('places/lobby/default.project.json', tree)
    await write('places/game/default.project.json', tree)
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.found.get('RARN_MODULE')).toBe('game.ReplicatedStorage.Packages')
    expect(scan.notes).toEqual([])
  })

  /**
   * Two DataModels putting one realm in different places means no single absolute
   * path is right for both. A guess produces the opaque Studio failure, so nothing is
   * derived and the reader is pointed at `place` — the actionable half.
   */
  test('two places disagreeing derive nothing and say so', async () => {
    await write('places/lobby/default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: '../../RARN_MODULE' } },
    })
    await write('places/game/default.project.json', {
      $className: 'DataModel',
      ServerStorage: { Shared: { $path: '../../RARN_MODULE' } },
    })
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.found.has('RARN_MODULE')).toBe(false)
    expect(scan.disputed.has('RARN_MODULE')).toBe(true)
    expect(scan.notes.join('\n')).toContain('Not deriving "place" from either')
  })

  // The dispute is already reported. Saying nothing mounts it would be the opposite
  // of what was just measured.
  test('a disputed realm is not also reported as unmounted', async () => {
    await write('places/lobby/default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: '../../RARN_MODULE' } },
    })
    await write('places/game/default.project.json', {
      $className: 'DataModel',
      ServerStorage: { Shared: { $path: '../../RARN_MODULE' } },
    })
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(unmountedRealms(scan, manifest, ['shared'])).toEqual([])
  })

  /**
   * A package install holds one `default.project.json` per package — hundreds of
   * library-form files describing somebody else's module. Reading them would say
   * nothing about this project and would make the scan cost scale with the install.
   */
  test('project files inside an install are not read', async () => {
    await write('RARN_MODULE/_Index/evaera_promise@4.0.0/default.project.json', { $path: 'lib' })
    const manifest = await project(undefined)

    expect((await scanPlaceProject(dir, manifest)).scanned).toBe(false)
  })

  // The root default file claims a realm first, so a stray file deeper in the tree
  // cannot turn the obvious answer into a dispute.
  test('the root default file is read before anything nested', async () => {
    await write('default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: 'RARN_MODULE' } },
    })
    await write('places/other/default.project.json', {
      $className: 'DataModel',
      ServerStorage: { Shared: { $path: '../../RARN_MODULE' } },
    })
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.notes.join('\n')).toContain(
      'default.project.json puts RARN_MODULE/ at game.ReplicatedStorage.Packages',
    )
  })

  async function dispute(first: string, second: string) {
    await write(`places/${first}/default.project.json`, {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: '../../RARN_MODULE' } },
    })
    await write(`places/${second}/default.project.json`, {
      $className: 'DataModel',
      ServerStorage: { Shared: { $path: '../../RARN_MODULE' } },
    })
  }

  // The file read first is the one a dispute names as the owner, and the order was
  // promised to be the same on every machine. Collated by locale, a machine set to
  // Czech read `places/dog` first — `ch` sorts after `h` there.
  test('reads project files in the same order on every machine', async () => {
    await dispute('chalk', 'dog')
    const manifest = await project(undefined)

    const scan = await asIfLocale('cs', () => scanPlaceProject(dir, manifest))
    expect(scan.notes.join('\n')).toContain('places/chalk/default.project.json puts RARN_MODULE/')
  })

  // Compared as the reader sees the path, not as the OS spells it. By code unit `\`
  // sorts after the digits and `/` before them, so comparing raw paths would put
  // `lobby2` first on Windows and `lobby` first everywhere else.
  test('orders sibling places the same way on every OS', async () => {
    await dispute('lobby', 'lobby2')
    const manifest = await project(undefined)

    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.notes.join('\n')).toContain('places/lobby/default.project.json puts RARN_MODULE/')
  })
})

describe('resolvePlace', () => {
  test('derives place when the manifest declares none', async () => {
    const manifest = await project({
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: 'RARN_MODULE' } },
    })
    const resolved = await resolvePlace(dir, manifest)
    expect(resolved.place.sharedPackages).toBe('game.ReplicatedStorage.Packages')
    expect(resolved.notes).toEqual([])
  })

  // Someone who wrote a path down meant it. Overriding it silently would make the
  // declared field a lie — but one of the two is still wrong, so it gets said.
  test('the manifest wins a disagreement, and the disagreement is reported', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: { Elsewhere: { $path: 'RARN_MODULE' } },
      },
      { place: { sharedPackages: 'game.ReplicatedStorage.Packages' } },
    )

    const resolved = await resolvePlace(dir, manifest)
    expect(resolved.place.sharedPackages).toBe('game.ReplicatedStorage.Packages')
    const text = resolved.notes.join('\n')
    expect(text).toContain('game.ReplicatedStorage.Packages')
    expect(text).toContain('game.ReplicatedStorage.Elsewhere')
  })

  test('agreement is silent', async () => {
    const manifest = await project(
      {
        $className: 'DataModel',
        ReplicatedStorage: { Packages: { $path: 'RARN_MODULE' } },
      },
      { place: { sharedPackages: 'game.ReplicatedStorage.Packages' } },
    )
    expect((await resolvePlace(dir, manifest)).notes).toEqual([])
  })

  test('leaves place empty when nothing declares or derives it', async () => {
    const manifest = await project(undefined)
    const resolved = await resolvePlace(dir, manifest)
    expect(resolved.place).toEqual({})
    expect(resolved.notes).toEqual([])
    expect(resolved.scan.scanned).toBe(false)
  })
})

describe('unmountedRealms', () => {
  // The failure a Wally import walks straight into: Wally used three independent
  // names, Rarn derives two of its three by suffix, so `Packages` is mounted and
  // `Packages_SERVER` is not. Rojo never syncs it and the realm is simply absent.
  test('warns about a realm the project file does not carry', async () => {
    const manifest = await project(
      { $className: 'DataModel', ReplicatedStorage: { Packages: { $path: 'Packages' } } },
      { packageDir: 'Packages' },
    )
    const { scan } = await resolvePlace(dir, manifest)

    const warnings = unmountedRealms(scan, manifest, ['shared', 'server'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Packages_SERVER/')
    expect(warnings[0]).toContain('no Rojo project file puts it anywhere')
  })

  test('says nothing about a realm that received no packages', async () => {
    const manifest = await project(
      { $className: 'DataModel', ReplicatedStorage: { Packages: { $path: 'Packages' } } },
      { packageDir: 'Packages' },
    )
    const { scan } = await resolvePlace(dir, manifest)
    expect(unmountedRealms(scan, manifest, ['shared'])).toEqual([])
  })

  // Without a project file there is nothing to be inconsistent with. Warning here
  // would fire on every project that syncs some other way.
  test('says nothing when there is no project file to check against', async () => {
    const manifest = await project(undefined)
    const { scan } = await resolvePlace(dir, manifest)
    expect(unmountedRealms(scan, manifest, ['shared', 'server', 'dev'])).toEqual([])
  })
})
