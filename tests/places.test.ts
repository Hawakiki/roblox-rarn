import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanPlaces } from '../src/doctor/places.ts'

/**
 * The check that looks past one manifest.
 *
 * Everything else Rarn verifies is scoped to a project, and a DataModel is not. Two
 * projects installed side by side, each correct and each reporting `no duplicates`,
 * become two ModuleScript instances of one package the moment a Rojo file mounts both
 * — measured with `rojo sourcemap`, and invisible to every other check.
 */

let dir: string
const REALMS = ['RARN_MODULE', 'RARN_MODULE_SERVER', 'RARN_MODULE_DEV']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-places-'))
  // The ascent stops at a repository root and nowhere else, so a fixture without one
  // would be testing the case where a member cannot see the place that mounts it.
  await mkdir(join(dir, '.git'), { recursive: true })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** An install tree: just the `_Index` entry names, which is all the check reads. */
async function install(at: string, entries: readonly string[]) {
  for (const entry of entries) {
    await mkdir(join(dir, at, '_Index', entry), { recursive: true })
  }
}

async function project(path: string, tree: unknown) {
  const full = join(dir, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, JSON.stringify({ name: 'ws', tree }, null, 2))
}

/** Two members under one place file, the arrangement R2 reproduced. */
async function twoMembers(alphaVersion: string, betaVersion: string) {
  await install('alpha/RARN_MODULE', [`evaera_promise@${alphaVersion}`])
  await install('beta/RARN_MODULE', [`evaera_promise@${betaVersion}`])
  await project('default.project.json', {
    $className: 'DataModel',
    ReplicatedStorage: {
      Alpha: { $path: 'alpha/RARN_MODULE' },
      Beta: { $path: 'beta/RARN_MODULE' },
    },
  })
}

describe('scanPlaces', () => {
  test('finds a compatible duplicate two projects put in one DataModel', async () => {
    await twoMembers('3.2.0', '3.2.1')

    const scan = await scanPlaces(join(dir, 'alpha'), REALMS)
    expect(scan.places).toHaveLength(1)

    const [place] = scan.places
    expect(place?.project).toBe('default.project.json')
    expect(place?.installs).toEqual(['alpha/RARN_MODULE', 'beta/RARN_MODULE'])

    const [duplicate] = place?.duplicates ?? []
    expect(duplicate?.name).toBe('@evaera/promise')
    expect(duplicate?.compatible).toBe(true)
    expect(duplicate?.versions.map((v) => v.version)).toEqual(['3.2.1', '3.2.0'])
  })

  // The member that did not "cause" it has the same problem, and running the check
  // from either directory has to say so — otherwise whose fault it is decides whether
  // anyone is told.
  test('reports from either member', async () => {
    await twoMembers('3.2.0', '3.2.1')

    const fromBeta = await scanPlaces(join(dir, 'beta'), REALMS)
    expect(fromBeta.places[0]?.duplicates[0]?.name).toBe('@evaera/promise')
  })

  // Two majors are two packages. Wally allows it, Rarn allows it, and constraint 1 is
  // not about it — so it is reported without being called a hazard.
  test('different majors are reported but not as the compatible kind', async () => {
    await twoMembers('3.2.0', '4.0.0')

    const [duplicate] = (await scanPlaces(join(dir, 'alpha'), REALMS)).places[0]?.duplicates ?? []
    expect(duplicate?.compatible).toBe(false)
  })

  test('one version in both trees is not a duplicate', async () => {
    await twoMembers('3.2.0', '3.2.0')
    expect((await scanPlaces(join(dir, 'alpha'), REALMS)).places).toEqual([])
  })

  /**
   * The question is what shares a DataModel with *this* project's packages. Without
   * that constraint the search wandered: a sibling directory with its own unrelated
   * project file was reported against a project that has nothing to do with it, which
   * is a worse failure than the silence it replaced.
   */
  test('says nothing about a place that does not mount this project', async () => {
    await twoMembers('3.2.0', '3.2.1')
    await install('unrelated/RARN_MODULE', ['evaera_promise@4.0.0'])

    expect((await scanPlaces(join(dir, 'unrelated'), REALMS)).places).toEqual([])
  })

  // A project's own realms are separate installs mounted into one DataModel, which is
  // the normal shape — and placement puts each package in exactly one of them, so this
  // must never read as a duplicate.
  test('shared and server realms of one project are not a duplicate', async () => {
    await install('RARN_MODULE', ['evaera_promise@4.0.0'])
    await install('RARN_MODULE_SERVER', ['sleitnick_comm@1.0.1'])
    await project('default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Packages: { $path: 'RARN_MODULE' } },
      ServerScriptService: { ServerPackages: { $path: 'RARN_MODULE_SERVER' } },
    })

    expect((await scanPlaces(dir, REALMS)).places).toEqual([])
  })

  // Nothing here reads a lockfile, so a tree Rarn did not create counts the same as
  // one it did — which is the point, since the DataModel does not distinguish them.
  test('a Wally install counts as one of the trees', async () => {
    await install('alpha/RARN_MODULE', ['evaera_promise@3.2.0'])
    await install('vendor/Packages', ['evaera_promise@3.2.1'])
    await project('default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: {
        Alpha: { $path: 'alpha/RARN_MODULE' },
        Vendor: { $path: 'vendor/Packages' },
      },
    })

    const [duplicate] = (await scanPlaces(join(dir, 'alpha'), REALMS)).places[0]?.duplicates ?? []
    expect(duplicate?.name).toBe('@evaera/promise')
    expect(duplicate?.compatible).toBe(true)
  })

  test('a project file mounting one install says nothing', async () => {
    await install('alpha/RARN_MODULE', ['evaera_promise@3.2.0'])
    await project('default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: { Alpha: { $path: 'alpha/RARN_MODULE' } },
    })

    expect((await scanPlaces(join(dir, 'alpha'), REALMS)).places).toEqual([])
  })

  // A directory that is not an install has no `_Index` and simply is not a tree.
  test('mounted source directories are not mistaken for installs', async () => {
    await install('alpha/RARN_MODULE', ['evaera_promise@3.2.0'])
    await mkdir(join(dir, 'src'), { recursive: true })
    await project('default.project.json', {
      $className: 'DataModel',
      ReplicatedStorage: {
        Alpha: { $path: 'alpha/RARN_MODULE' },
        Source: { $path: 'src' },
      },
    })

    expect((await scanPlaces(join(dir, 'alpha'), REALMS)).places).toEqual([])
  })

  /**
   * The ascent stops at a repository root and nowhere else.
   *
   * Falling back to "one level up" scanned a directory nobody said was related. For a
   * project sitting in a shared folder that is every unrelated sibling, and the earlier
   * version of this check took over five seconds to walk a system temp directory before
   * answering. Silence is the right answer when there is no stated boundary.
   */
  test('without a repository root the search stays where it started', async () => {
    await twoMembers('3.2.0', '3.2.1')
    await rm(join(dir, '.git'), { recursive: true, force: true })

    expect((await scanPlaces(join(dir, 'alpha'), REALMS)).places).toEqual([])
  })

  test('a malformed project file is skipped rather than thrown over', async () => {
    await install('alpha/RARN_MODULE', ['evaera_promise@3.2.0'])
    await install('beta/RARN_MODULE', ['evaera_promise@3.2.1'])
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'default.project.json'), '{ not json')

    expect((await scanPlaces(join(dir, 'alpha'), REALMS)).places).toEqual([])
  })
})
