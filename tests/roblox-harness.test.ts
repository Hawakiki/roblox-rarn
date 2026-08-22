import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { link } from '../src/linker/link.ts'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import type { Resolution, ResolvedPackage } from '../src/resolver/types.ts'
import { parseWallyName } from '../src/util/package-name.ts'

/**
 * Runs the Lune harness over a tree this test just built.
 *
 * The unit tests check that the linker writes the files it meant to. This checks
 * something they cannot: that the tree *resolves* under Roblox's rules, and that a
 * package reached by two paths really is one instance. A file-tree assertion cannot
 * see the difference between one copy and two — both look correct on disk.
 *
 * Skipped when Lune is absent, since it is a Roblox-side tool and nothing about
 * building Rarn requires it.
 */

const REPO = join(import.meta.dir, '..')

/** rokit's shim if it is installed, otherwise whatever is on PATH, otherwise nothing. */
function findLune(): string | null {
  const local = join(homedir(), '.rokit', 'bin', process.platform === 'win32' ? 'lune.exe' : 'lune')
  if (existsSync(local)) return local
  return Bun.which('lune')
}

const lune = findLune()

// The skip is announced. A harness that quietly does not run reads exactly like a
// harness that ran and passed, and this is the only test that can tell one shared
// package from two copies of it — the failure it catches is invisible on disk.
if (lune === null) {
  console.warn(
    '\n  lune 이 없어 require 하니스를 건너뛴다. `rokit install` 로 rokit.toml 의 핀을 설치하면 실행된다.\n',
  )
}

async function runHarness(
  installDir: string,
  extra: readonly string[] = [],
): Promise<{ code: number; output: string }> {
  // The fallback is unreachable — the suite below is skipped when `lune` is null —
  // and exists so the type stays honest without an assertion.
  const proc = Bun.spawn(
    [lune ?? 'lune', 'run', 'tests/roblox/verify.luau', '--', installDir, ...extra],
    {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, output: stdout + stderr }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarn-harness-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A diamond: two packages depending on one shared package.
 *
 * The smallest graph where deduplication is observable — `Base` is reached from the
 * root, from `Left`, and from `Right`, and all three must land on one instance.
 */
async function buildDiamond(): Promise<string> {
  const project = join(dir, 'project')
  await mkdir(project, { recursive: true })

  const specs = [
    { name: 'a/left', deps: { Base: '@a/base@1.0.0' } },
    { name: 'a/right', deps: { Base: '@a/base@1.0.0' } },
    { name: 'a/base', deps: {} },
  ]

  const packages = new Map<string, ResolvedPackage>()
  const sources = new Map<string, string>()

  for (const spec of specs) {
    const name = parseWallyName(spec.name)
    const key = `@${spec.name}@1.0.0`
    const source = join(dir, 'cache', `${name.scope}_${name.name}`)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'init.lua'), `return { name = "${name.name}" }`)
    sources.set(key, source)

    packages.set(key, {
      name,
      version: '1.0.0',
      realm: 'shared',
      placement: 'shared',
      dependencies: new Map(Object.entries(spec.deps)),
      requestedBy: [{ from: 'root', range: '*', placement: 'shared' }],
      dev: false,
      forcedBy: undefined,
    })
  }

  const manifest: Manifest = {
    name: 'game',
    version: '1.0.0',
    dependencies: { '@a/left': '^1.0.0', '@a/right': '^1.0.0', '@a/base': '^1.0.0' },
  }

  const resolution: Resolution = { packages, duplicates: new Map(), overrides: new Map() }
  await link({
    projectDir: project,
    manifest: normalizeManifest(manifest),
    resolution,
    sources,
  })

  return join(project, 'RARN_MODULE')
}

/**
 * A server package whose dependency is placed in the shared realm.
 *
 * The realms sync to different Roblox services, so the generated shim cannot walk
 * relatively — it names an absolute DataModel path out of `place`. That is the one
 * shim form the harness could not check until it learned to mount sibling realms,
 * and it reported the correct form as a failure while it could not.
 */
async function buildCrossRealm(): Promise<{ server: string; shared: string }> {
  const project = join(dir, 'cross')
  await mkdir(project, { recursive: true })

  const packages = new Map<string, ResolvedPackage>()
  const sources = new Map<string, string>()

  const specs = [
    { name: 'a/server-thing', placement: 'server' as const, deps: { Base: '@a/base@1.0.0' } },
    { name: 'a/base', placement: 'shared' as const, deps: {} },
  ]

  for (const spec of specs) {
    const name = parseWallyName(spec.name)
    const key = `@${spec.name}@1.0.0`
    const source = join(dir, 'cross-cache', `${name.scope}_${name.name}`)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'init.lua'), `return { name = "${name.name}" }`)
    sources.set(key, source)

    packages.set(key, {
      name,
      version: '1.0.0',
      realm: spec.placement === 'server' ? 'server' : 'shared',
      placement: spec.placement,
      dependencies: new Map(Object.entries(spec.deps)),
      requestedBy: [{ from: 'root', range: '*', placement: spec.placement }],
      dev: false,
      forcedBy: undefined,
    })
  }

  const manifest: Manifest = {
    name: 'game',
    version: '1.0.0',
    place: { sharedPackages: 'game.ReplicatedStorage.RARN_MODULE' },
    dependencies: { '@a/base': '^1.0.0' },
    serverDependencies: { '@a/server-thing': '^1.0.0' },
  }

  const resolution: Resolution = { packages, duplicates: new Map(), overrides: new Map() }
  await link({
    projectDir: project,
    manifest: normalizeManifest(manifest),
    resolution,
    sources,
  })

  return { server: join(project, 'RARN_MODULE_SERVER'), shared: join(project, 'RARN_MODULE') }
}

/**
 * A realm that holds nothing but a cross-realm shim.
 *
 * Placement resolves to the widest requester, so a package declared under
 * `serverDependencies` that a shared package also needs is stored in the shared realm.
 * The server directory then keeps only the shim pointing across at it, and has no
 * `_Index` at all — which is correct, and which the harness used to exit 1 on.
 */
async function buildShimOnlyRealm(): Promise<{ server: string; shared: string }> {
  const project = join(dir, 'shim-only')
  await mkdir(project, { recursive: true })

  const name = parseWallyName('a/base')
  const key = '@a/base@1.0.0'
  const source = join(dir, 'shim-only-cache', 'a_base')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'init.lua'), 'return { name = "base" }')

  // Declared as a server dependency, but placed in shared because the root also
  // depends on it there. That is what leaves the server realm with only a shim.
  const packages = new Map<string, ResolvedPackage>([
    [
      key,
      {
        name,
        version: '1.0.0',
        realm: 'shared',
        placement: 'shared',
        dependencies: new Map(),
        requestedBy: [{ from: 'root', range: '*', placement: 'shared' }],
        dev: false,
        forcedBy: undefined,
      },
    ],
  ])

  await link({
    projectDir: project,
    manifest: normalizeManifest({
      name: 'game',
      version: '1.0.0',
      place: { sharedPackages: 'game.ReplicatedStorage.RARN_MODULE' },
      dependencies: { '@a/base': '^1.0.0' },
      serverDependencies: { '@a/base': '^1.0.0' },
    }),
    resolution: { packages, duplicates: new Map(), overrides: new Map() },
    sources: new Map([[key, source]]),
  })

  return { server: join(project, 'RARN_MODULE_SERVER'), shared: join(project, 'RARN_MODULE') }
}

describe.skipIf(lune === null)('Lune require harness', () => {
  test('a linked tree resolves and deduplicates', async () => {
    const installDir = await buildDiamond()
    const { code, output } = await runHarness(installDir)

    expect(output).toContain('checks passed')
    expect(output).not.toContain('FAIL')
    expect(code).toBe(0)
  }, 30_000)

  test('the identity check actually runs, rather than being vacuously satisfied', async () => {
    const installDir = await buildDiamond()
    const { output } = await runHarness(installDir)
    // Naming the assertion explicitly: a harness that silently checked nothing would
    // still print "checks passed".
    expect(output).toContain('_Index["a_left@1.0.0"].Base')
    expect(output).toMatch(/Base: RARN_MODULE\.Base == _Index/)
  }, 30_000)

  // Without these the suite could not tell a working harness from one that always
  // passes. Each control breaks the tree in a way only the harness can see.
  test('catches a duplicated package', async () => {
    const installDir = await buildDiamond()
    await cp(
      join(installDir, '_Index', 'a_base@1.0.0'),
      join(installDir, '_Index', 'a_base@1.0.1'),
      { recursive: true },
    )
    await writeFile(
      join(installDir, '_Index', 'a_left@1.0.0', 'Base.luau'),
      '-- Generated by Rarn.\nreturn require(script.Parent.Parent["a_base@1.0.1"]["base"])\n',
    )

    const { code, output } = await runHarness(installDir)
    expect(output).toContain('FAIL')
    expect(output).toContain('two copies resolved')
    expect(code).not.toBe(0)
  }, 30_000)

  test('catches a module left nested one level too deep', async () => {
    const installDir = await buildDiamond()
    const base = join(installDir, '_Index', 'a_base@1.0.0', 'base')
    await mkdir(join(base, 'lib'), { recursive: true })
    await writeFile(join(base, 'lib', 'init.lua'), 'return {}')
    await rm(join(base, 'init.lua'))

    const { code, output } = await runHarness(installDir)
    expect(output).toContain('pruning may have left it nested')
    expect(code).not.toBe(0)
  }, 30_000)

  // The form every cross-realm link takes. Before mounts existed, this reported the
  // correct shim as broken — so the check the harness most needed to make was the one
  // it could not, and CI never called it this way to find out.
  test('a cross-realm shim resolves when the other realm is mounted', async () => {
    const { server, shared } = await buildCrossRealm()
    const { code, output } = await runHarness(server, [
      'RARN_MODULE_SERVER',
      `--mount=game.ReplicatedStorage.RARN_MODULE=${shared}`,
    ])

    expect(output).toContain('checks passed')
    expect(output).not.toContain('FAIL')
    expect(output).not.toContain('not verified')
    expect(code).toBe(0)
  }, 30_000)

  // The alternative to a false failure is not a silent pass. Without a mount the
  // check cannot be made, and the run has to say which one it skipped.
  test('without a mount it reports the check as unverified rather than failed', async () => {
    const { server } = await buildCrossRealm()
    const { code, output } = await runHarness(server, ['RARN_MODULE_SERVER'])

    expect(output).toContain('not verified')
    expect(output).toContain('cross-realm shim points at game.ReplicatedStorage.RARN_MODULE')
    expect(output).not.toContain('FAIL')
    expect(code).toBe(0)
  }, 30_000)

  /**
   * Found by `test/game`, which is what an over-built fixture is for. The harness
   * exited 1 on a realm with no `_Index`, calling a correct install broken — the same
   * shape of mistake as reporting an unmounted cross-realm shim as a failure.
   */
  test('a realm holding only cross-realm shims is not a failure', async () => {
    const { server, shared } = await buildShimOnlyRealm()
    const { code, output } = await runHarness(server, [
      'RARN_MODULE_SERVER',
      `--mount=game.ReplicatedStorage.RARN_MODULE=${shared}`,
    ])

    expect(code).toBe(0)
    expect(output).toContain('no _Index')
    expect(output).toContain('require(RARN_MODULE_SERVER.Base)')
  })

  // Nothing to check is not the same as nothing being there. An empty directory has
  // no shims either, and that one really is broken.
  test('a realm with neither _Index nor shims still fails', async () => {
    const empty = join(dir, 'empty-realm')
    await mkdir(empty, { recursive: true })

    const { code } = await runHarness(empty, ['RARN_MODULE_SERVER'])
    expect(code).not.toBe(0)
  })

  test('catches a shim pointing at nothing', async () => {
    const installDir = await buildDiamond()
    await writeFile(
      join(installDir, 'Base.luau'),
      '-- Generated by Rarn.\nreturn require(script.Parent._Index["a_base@9.9.9"]["base"])\n',
    )

    const { code, output } = await runHarness(installDir)
    expect(output).toContain('FAIL')
    expect(code).not.toBe(0)
  }, 30_000)
})
