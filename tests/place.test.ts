import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import { resolvePlace, scanPlaceProject, unmountedRealms } from '../src/project/place.ts'

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

  // A library's project file is `{ "tree": { "$path": "src" } }`. It describes a
  // module, not a place; walking it would find nothing while implying a check ran.
  test('a library project file is not scanned at all', async () => {
    const manifest = await project({ $path: 'src' })
    const scan = await scanPlaceProject(dir, manifest)
    expect(scan.scanned).toBe(false)
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
    expect(scan.notes.join('\n')).toContain('mounts Packages/ at both')
  })

  test('a directory that is not a realm is ignored', async () => {
    const manifest = await project({
      $className: 'DataModel',
      ReplicatedStorage: { Models: { $path: 'models' } },
    })
    expect((await scanPlaceProject(dir, manifest)).found.size).toBe(0)
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
    expect(warnings[0]).toContain('Rojo will not sync it')
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
