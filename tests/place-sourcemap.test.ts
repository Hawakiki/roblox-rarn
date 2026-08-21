import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeManifest } from '../src/manifest/read.ts'
import { scanPlaceProject } from '../src/project/place.ts'

/**
 * Checks the derived DataModel path against the one Rojo actually produces.
 *
 * `scanPlaceProject` reads a project file and says where a realm directory will end
 * up. Nothing in the unit tests can tell whether that reading is *right* — they
 * compare it against another statement of the same assumption. `rojo sourcemap`
 * emits the instance tree Rojo will really build, so comparing against it is the
 * closest thing to asking Rojo directly, and it needs no Studio and no network.
 *
 * It is the same argument as the Lune harness, one layer up: the harness checks that
 * requires resolve inside a realm, this checks that the realm is where Rarn told the
 * shims it would be.
 */
function findRojo(): string | null {
  const local = join(homedir(), '.rokit', 'bin', process.platform === 'win32' ? 'rojo.exe' : 'rojo')
  if (existsSync(local)) return local
  return Bun.which('rojo')
}

const rojo = findRojo()

if (rojo === null) {
  console.warn('\n  rojo 가 없어 소스맵 대조를 건너뛴다. `rokit install` 로 설치하면 실행된다.\n')
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-sourcemap-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Every DataModel path in a Rojo sourcemap, as `game.Service.Thing`. */
function pathsIn(node: unknown): string[] {
  const out: string[] = []
  const walk = (value: unknown, trail: string[]): void => {
    if (typeof value !== 'object' || value === null) return
    const { name, children } = value as { name?: unknown; children?: unknown }
    if (typeof name !== 'string') return

    const here = trail.length === 0 ? ['game'] : [...trail, name]
    if (trail.length > 0) out.push(here.join('.'))
    if (Array.isArray(children)) for (const child of children) walk(child, here)
  }
  walk(node, [])
  return out
}

/**
 * Run from the repository, not from the temp project.
 *
 * A rokit shim resolves its tool against a project manifest in the working
 * directory; from a bare temp directory it refuses with "Failed to find tool 'rojo'"
 * and writes nothing to stdout. Rojo resolves `$path` relative to the project file,
 * so pointing at an absolute one from here gives the same tree without copying
 * `rokit.toml` into every fixture.
 */
async function sourcemapPaths(projectDir: string): Promise<string[]> {
  const proc = Bun.spawn([rojo ?? 'rojo', 'sourcemap', join(projectDir, 'default.project.json')], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [text, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited

  // Parsing empty output would fail as "Unexpected EOF", which says nothing about
  // the tool having refused to run. Whatever rojo said is more useful than that.
  if (code !== 0 || text.trim() === '') {
    throw new Error(`rojo sourcemap exited ${code}: ${err.trim() || '(no output)'}`)
  }

  return pathsIn(JSON.parse(text))
}

describe.skipIf(rojo === null)('derived place matches the real Rojo tree', () => {
  test.each([
    // The DataModel name and the folder name differ, which is the whole reason the
    // path cannot be guessed from `packageDir`.
    ['a renamed mount', 'SharedPkgs', 'game.ReplicatedStorage.SharedPkgs'],
    ['a mount with the same name', 'RARN_MODULE', 'game.ReplicatedStorage.RARN_MODULE'],
  ])(
    '%s',
    async (_label, instanceName, expected) => {
      await mkdir(join(dir, 'RARN_MODULE'), { recursive: true })
      await writeFile(join(dir, 'RARN_MODULE', 'Promise.luau'), 'return 1\n')
      await writeFile(
        join(dir, 'default.project.json'),
        JSON.stringify({
          name: 'probe',
          tree: {
            $className: 'DataModel',
            ReplicatedStorage: { [instanceName]: { $path: 'RARN_MODULE' } },
          },
        }),
      )

      const manifest = normalizeManifest({ name: '@me/probe', version: '1.0.0' })
      const derived = (await scanPlaceProject(dir, manifest)).found.get('RARN_MODULE')

      expect(derived).toBe(expected)
      expect(await sourcemapPaths(dir)).toContain(expected)
    },
    30_000,
  )

  // The shims inside a realm are reached relatively, but the entry folder has to be
  // where the cross-realm path says — so the check has to go past the realm root.
  test('the path holds all the way into _Index', async () => {
    const entry = join(dir, 'RARN_MODULE', '_Index', 'evaera_promise@4.0.0', 'promise')
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'init.luau'), 'return {}\n')
    await writeFile(
      join(dir, 'default.project.json'),
      JSON.stringify({
        name: 'probe',
        tree: {
          $className: 'DataModel',
          ReplicatedStorage: { Pkgs: { $path: 'RARN_MODULE' } },
        },
      }),
    )

    const paths = await sourcemapPaths(dir)
    expect(paths).toContain('game.ReplicatedStorage.Pkgs._Index')
    // The exact instance a cross-realm shim names.
    expect(paths).toContain('game.ReplicatedStorage.Pkgs._Index.evaera_promise@4.0.0.promise')
  }, 30_000)
})
