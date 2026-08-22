import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { normalizeManifest } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import { collect, matches, pack } from '../src/publish/pack.ts'
import { renderWallyToml, toCargoRange } from '../src/publish/wally-toml.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'

const manifestOf = (partial: Partial<Manifest> = {}) =>
  normalizeManifest({ name: '@me/thing', version: '1.0.0', ...partial })

describe('toCargoRange', () => {
  // The whole reason this function exists: npm separates an AND with a space,
  // Cargo with a comma, and Cargo does not throw on the wrong one — it reads
  // `>=1.0.0 <2.0.0` as a single malformed comparator.
  test('a space-separated AND becomes comma-separated', () => {
    expect(toCargoRange('>=1.0.0 <2.0.0', '@a/b')).toBe('>=1.0.0, <2.0.0')
  })

  test('a lone comparator is unchanged', () => {
    expect(toCargoRange('^1.2.0', '@a/b')).toBe('^1.2.0')
    expect(toCargoRange('~1.2.3', '@a/b')).toBe('~1.2.3')
    expect(toCargoRange('1.2.3', '@a/b')).toBe('1.2.3')
  })

  // Space inside one comparator is not a separator and must be closed up first,
  // or `>= 1.0.0` would be published as two requirements.
  test('space inside a comparator is closed, not split', () => {
    expect(toCargoRange('>= 1.0.0 < 2.0.0', '@a/b')).toBe('>=1.0.0, <2.0.0')
  })

  // Refused rather than approximated: widening a range would publish a package
  // whose declared dependencies are not the ones the author tested.
  test('OR is refused — Cargo has no equivalent', () => {
    expect(() => toCargoRange('^1.0.0 || ^2.0.0', '@a/b')).toThrow(RarnError)
    try {
      toCargoRange('^1.0.0 || ^2.0.0', '@a/b')
    } catch (error) {
      expect((error as RarnError).code).toBe(Code.UnpublishableRange)
    }
  })

  test('a hyphen range is refused', () => {
    expect(() => toCargoRange('1.0.0 - 2.0.0', '@a/b')).toThrow(RarnError)
  })

  test('nonsense is refused', () => {
    expect(() => toCargoRange('not-a-range', '@a/b')).toThrow(RarnError)
  })
})

describe('renderWallyToml', () => {
  test('writes the wally name, not the rarn one', () => {
    expect(renderWallyToml(manifestOf())).toContain('name = "me/thing"')
  })

  test('carries version, realm and registry', () => {
    const toml = renderWallyToml(manifestOf({ version: '2.3.4', realm: 'server' }))
    expect(toml).toContain('version = "2.3.4"')
    expect(toml).toContain('realm = "server"')
    expect(toml).toContain('registry = "https://github.com/UpliftGames/wally-index"')
  })

  test('dependency keys are the shim aliases, values are Cargo ranges', () => {
    const toml = renderWallyToml(manifestOf({ dependencies: { '@evaera/promise': '^4.0.0' } }))
    expect(toml).toContain('[dependencies]')
    expect(toml).toContain('Promise = "evaera/promise@^4.0.0"')
  })

  test('each dependency section is separate', () => {
    const toml = renderWallyToml(
      manifestOf({
        dependencies: { '@evaera/promise': '^4.0.0' },
        serverDependencies: { '@sleitnick/knit': '^1.0.0' },
        devDependencies: { '@roblox/testez': '^0.4.0' },
      }),
    )
    expect(toml).toContain('[dependencies]')
    expect(toml).toContain('[server-dependencies]')
    expect(toml).toContain('[dev-dependencies]')
  })

  test('an empty section is omitted rather than left blank', () => {
    expect(renderWallyToml(manifestOf())).not.toContain('[dependencies]')
  })

  test('quotes are escaped so the TOML stays parseable', () => {
    const toml = renderWallyToml(manifestOf({ description: 'a "quoted" thing' }))
    expect(toml).toContain('description = "a \\"quoted\\" thing"')
  })

  // A range that cannot be published must fail here, before an upload starts.
  test('an unpublishable range fails the render', () => {
    expect(() => renderWallyToml(manifestOf({ dependencies: { '@a/b': '^1 || ^2' } }))).toThrow(
      RarnError,
    )
  })
})

describe('matches', () => {
  test('* stays inside one segment', () => {
    expect(matches('a.luau', '*.luau')).toBe(true)
    expect(matches('src/a.luau', '*.luau')).toBe(false)
  })

  test('** crosses segments', () => {
    expect(matches('src/deep/a.luau', 'src/**')).toBe(true)
    expect(matches('docs/x/y/z.md', 'docs/**')).toBe(true)
  })

  // Making the user write `docs/**` for an obvious case would be a trap.
  test('a bare directory name means its whole subtree', () => {
    expect(matches('docs/readme.md', 'docs')).toBe(true)
    expect(matches('docs/a/b.md', 'docs')).toBe(true)
    expect(matches('documents/a.md', 'docs')).toBe(false)
  })

  test('an exact path matches itself', () => {
    expect(matches('rarn.lock', 'rarn.lock')).toBe(true)
  })

  test('a dot in the pattern is literal, not any-character', () => {
    expect(matches('axluau', '*.luau')).toBe(false)
  })
})

describe('collect and installed trees', () => {
  async function tree(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'rarn-pack-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, ...path.split('/'))
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, body)
    }
    return dir
  }

  /**
   * Wally installs into `Packages/`, `ServerPackages/` and `DevPackages/`, and Rarn
   * cannot derive those from `packageDir` because they are another tool's names. A
   * project that migrated still has them, and publishing is permanent — the first real
   * package Rarn published came to 388 files before this, 339 of them a `DevPackages/`
   * nobody meant to ship.
   */
  test("another tool's install directories are not published", async () => {
    const dir = await tree({
      'init.luau': 'return 1',
      'Packages/Promise.luau': 'return 1',
      'Packages/_Index/evaera_promise@4.0.0/promise/init.luau': 'return 1',
      'DevPackages/_Index/roblox_testez@0.4.1/testez/init.luau': 'return 1',
    })

    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })

  // The shim beside `_Index` belongs to the install too, so excluding only what is
  // *under* `_Index` would leave the top-level shims behind.
  test('the shims beside _Index go with it', async () => {
    const dir = await tree({
      'init.luau': 'return 1',
      'Packages/Promise.luau': 'return 1',
      'Packages/_Index/a@1.0.0/a/init.luau': 'return 1',
    })

    const files = await collect(dir, manifestOf())
    expect(files).not.toContain('Packages/Promise.luau')
  })

  /**
   * The reason this looks for `_Index` instead of matching the names: a project is
   * free to keep its own source in a directory called `Packages`, and excluding it by
   * name would publish an empty archive with no way for `include` to rescue it.
   */
  test('a source directory that merely shares the name still ships', async () => {
    const dir = await tree({
      'init.luau': 'return 1',
      'Packages/mine.luau': 'return 1',
      'Packages/deep/also.luau': 'return 1',
    })

    expect(await collect(dir, manifestOf())).toEqual([
      'Packages/deep/also.luau',
      'Packages/mine.luau',
      'init.luau',
    ])
  })

  // Rarn's own realms were already excluded by name, which still works when the realm
  // holds nothing but root shims and therefore has no `_Index` to recognise.
  test("Rarn's own realm is excluded even with no _Index in it", async () => {
    const dir = await tree({
      'init.luau': 'return 1',
      'RARN_MODULE/Promise.luau': 'return 1',
    })

    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })
})

describe('collect', () => {
  const project = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'rarn-pack-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, body)
    }
    return dir
  }

  test('takes everything when include is absent', async () => {
    const dir = await project({ 'init.luau': 'return 1', 'src/a.luau': 'return 2' })
    expect(await collect(dir, manifestOf())).toEqual(['init.luau', 'src/a.luau'])
  })

  test('include is a whitelist', async () => {
    const dir = await project({ 'init.luau': 'x', 'docs/a.md': 'y', 'src/b.luau': 'z' })
    const files = await collect(dir, manifestOf({ include: ['init.luau', 'src/**'] }))
    expect(files).toEqual(['init.luau', 'src/b.luau'])
  })

  test('exclude wins over include', async () => {
    const dir = await project({ 'src/a.luau': 'x', 'src/a.spec.luau': 'y' })
    const files = await collect(
      dir,
      manifestOf({ include: ['src/**'], exclude: ['**/*.spec.luau'] }),
    )
    expect(files).toEqual(['src/a.luau'])
  })

  // The one that matters most for the 2 MiB limit: the realm directories hold
  // every dependency's full source, so shipping them would put a second copy of
  // half the registry inside the archive.
  test('the package directory is never included', async () => {
    const dir = await project({
      'init.luau': 'x',
      'RARN_MODULE/Promise.luau': 'y',
      'RARN_MODULE/_Index/evaera_promise@4.0.0/promise/init.lua': 'z',
    })
    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })

  test('a renamed package directory is excluded too', async () => {
    const dir = await project({ 'init.luau': 'x', 'Packages/Promise.luau': 'y' })
    expect(await collect(dir, manifestOf({ packageDir: 'Packages' }))).toEqual(['init.luau'])
  })

  test('the lockfile and place files are excluded', async () => {
    const dir = await project({ 'init.luau': 'x', 'rarn.lock': '{}', 'game.rbxl': 'bin' })
    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })
})

describe('pack', () => {
  const project = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'rarn-pack-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, body)
    }
    return dir
  }

  // `rarn init` names a project after its folder, so a bare name reaches this from
  // Rarn's own output rather than from anything the user typed. The old message came
  // out of `parsePackageName` inside `renderWallyToml` and read as an accusation.
  test('a bare name is refused with a message about scopes, not about a missing @', async () => {
    const dir = await project({ 'init.luau': 'return 1' })
    let thrown: unknown
    try {
      await pack(dir, manifestOf({ name: 'mygame' }))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(RarnError)
    const error = thrown as RarnError
    expect(error.code).toBe(Code.UnscopedPackage)
    expect(error.what).toContain('mygame')
    expect(error.how).toContain('@<your-github-name>/mygame')
    // The old failure. Reaching it again means the guard stopped running.
    expect(error.code).not.toBe(Code.InvalidPackageName)
  })

  test('always adds a generated wally.toml', async () => {
    const dir = await project({ 'init.luau': 'return 1' })
    const result = await pack(dir, manifestOf())

    const unpacked = unzipSync(result.archive)
    expect(Object.keys(unpacked).sort()).toEqual(['init.luau', 'wally.toml'])
    expect(new TextDecoder().decode(unpacked['wally.toml'])).toContain('name = "me/thing"')
  })

  // The manifest of record is rarn.json. A stale hand-written wally.toml winning
  // would publish a name or version nobody asked for.
  test('a checked-in wally.toml does not shadow the generated one', async () => {
    const dir = await project({
      'init.luau': 'x',
      'wally.toml': '[package]\nname = "someone/else"\nversion = "9.9.9"\n',
    })
    const result = await pack(dir, manifestOf())

    const text = new TextDecoder().decode(unzipSync(result.archive)['wally.toml'])
    expect(text).toContain('name = "me/thing"')
    expect(text).not.toContain('someone/else')
  })

  test('the same input produces the same bytes', async () => {
    const dir = await project({ 'init.luau': 'return 1' })
    const first = await pack(dir, manifestOf())
    const second = await pack(dir, manifestOf())
    expect(Buffer.from(first.archive).equals(Buffer.from(second.archive))).toBe(true)
  })

  test('an empty project is refused', async () => {
    const dir = await project({ 'rarn.lock': '{}' })
    expect(pack(dir, manifestOf())).rejects.toThrow(RarnError)
  })

  test('entries are sorted and counted', async () => {
    const dir = await project({ 'b.luau': 'x', 'a.luau': 'y' })
    const result = await pack(dir, manifestOf())
    expect(result.entries.map((e) => e.path)).toEqual(['a.luau', 'b.luau', 'wally.toml'])
  })
})

describe('secrets are never packed', () => {
  const project = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'rarn-secret-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, body)
    }
    return dir
  }

  // A published version is permanent and public. This is the one exclusion whose
  // absence cannot be fixed after the fact — only the credential can be rotated.
  test('a .env is excluded, at the root and nested', async () => {
    const dir = await project({
      'init.luau': 'x',
      '.env': 'TOKEN=hunter2',
      '.env.local': 'TOKEN=hunter2',
      'config/.env': 'TOKEN=hunter2',
    })
    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })

  test('keys and certificates are excluded', async () => {
    const dir = await project({
      'init.luau': 'x',
      'server.key': 'k',
      'certs/server.pem': 'p',
    })
    expect(await collect(dir, manifestOf())).toEqual(['init.luau'])
  })

  // Excluded by default, not forbidden. Naming the file exactly can only be
  // deliberate, so it wins.
  test('an exact include overrides the default exclusion', async () => {
    const dir = await project({ 'init.luau': 'x', '.env': 'PUBLIC=1' })
    const files = await collect(dir, manifestOf({ include: ['init.luau', '.env'] }))
    expect(files).toEqual(['.env', 'init.luau'])
  })

  // The distinction that makes the override safe: a glob is a statement about a
  // directory, not about the secret that happens to sit in it.
  test('a glob include does not override it', async () => {
    const dir = await project({ 'src/a.luau': 'x', 'src/.env': 'TOKEN=1' })
    expect(await collect(dir, manifestOf({ include: ['src/**'] }))).toEqual(['src/a.luau'])
  })

  // `exclude` is last, so it overrides even an exact include.
  test('an explicit exclude still wins', async () => {
    const dir = await project({ 'init.luau': 'x', '.env': 'PUBLIC=1' })
    const files = await collect(
      dir,
      manifestOf({ include: ['init.luau', '.env'], exclude: ['.env'] }),
    )
    expect(files).toEqual(['init.luau'])
  })
})
