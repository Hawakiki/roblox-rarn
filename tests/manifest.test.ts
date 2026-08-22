import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeManifest, readManifest, suggestPackageName } from '../src/manifest/read.ts'
import type { Manifest } from '../src/manifest/types.ts'
import { validateManifest } from '../src/manifest/validate.ts'
import { serializeManifest, withDependency, withoutDependency } from '../src/manifest/write.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'

const minimal: Manifest = { name: 'my-game', version: '0.1.0' }

function expectCode(fn: () => unknown, code: string): RarnError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(code as never)
    return error as RarnError
  }
  throw new Error(`expected ${code} but nothing was thrown`)
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<RarnError> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    expect((error as RarnError).code).toBe(code as never)
    return error as RarnError
  }
  throw new Error(`expected ${code} but nothing was thrown`)
}

describe('validateManifest — shape', () => {
  test('accepts a minimal manifest', () => {
    expect(validateManifest(minimal, 'rarn.json')).toEqual(minimal)
  })

  test('accepts every optional field together', () => {
    const full: Manifest = {
      ...minimal,
      description: 'a game',
      license: 'MIT',
      authors: ['someone'],
      private: true,
      realm: 'server',
      packageDir: 'RARN_MODULE',
      place: { sharedPackages: 'game.ReplicatedStorage.Packages' },
      dependencies: { '@evaera/promise': '^4.0.0' },
      serverDependencies: { '@sleitnick/comm': '^1.0.0' },
      devDependencies: { '@roblox/testez': '^0.4.1' },
      resolutions: { '@evaera/promise': '4.0.0' },
      aliases: { '@evaera/promise': 'Promise' },
    }
    expect(validateManifest(full, 'rarn.json')).toEqual(full)
  })

  test.each([
    ['missing name', { version: '1.0.0' }],
    ['missing version', { name: 'x' }],
    ['unknown field', { ...minimal, nope: 1 }],
    ['unscoped dependency key', { ...minimal, dependencies: { promise: '^4.0.0' } }],
    ['bad realm', { ...minimal, realm: 'client' }],
    ['place path not rooted at game', { ...minimal, place: { sharedPackages: 'Workspace.X' } }],
  ])('rejects: %s', (_label, data) => {
    expectCode(() => validateManifest(data, 'rarn.json'), Code.ManifestInvalid)
  })

  // The whole point of the two-pass split: a schema error must name the field.
  test('names the offending field instead of dumping a pointer', () => {
    const error = expectCode(
      () => validateManifest({ ...minimal, dependencies: { BadKey: '^1.0.0' } }, 'rarn.json'),
      Code.ManifestInvalid,
    )
    expect(error.detail).toContain('dependencies')
    expect(error.detail).not.toContain('~1')
  })
})

describe('validateManifest — semantics', () => {
  // A schema cannot tell a real semver range from a plausible-looking one.
  test('rejects a range the schema would accept', () => {
    const error = expectCode(
      () => validateManifest({ ...minimal, dependencies: { '@a/b': '^^4' } }, 'rarn.json'),
      Code.InvalidVersionRange,
    )
    expect(error.what).toContain('dependencies["@a/b"]')
    expect(error.what).toContain('^^4')
  })

  test('rejects a non-exact version', () => {
    expectCode(
      () => validateManifest({ ...minimal, version: '1.0' }, 'rarn.json'),
      Code.InvalidVersion,
    )
  })

  test('accepts a Cargo-style range, since the registry speaks that', () => {
    expect(() =>
      validateManifest({ ...minimal, dependencies: { '@a/b': '>=1.0.0, <2.0.0' } }, 'rarn.json'),
    ).not.toThrow()
  })

  // An override that still needed resolving would not override anything.
  test('rejects a range in resolutions', () => {
    const error = expectCode(
      () => validateManifest({ ...minimal, resolutions: { '@a/b': '^4.0.0' } }, 'rarn.json'),
      Code.InvalidVersion,
    )
    expect(error.what).toContain('exact version')
  })

  test('accepts an exact version in resolutions', () => {
    expect(() =>
      validateManifest({ ...minimal, resolutions: { '@a/b': '4.0.0' } }, 'rarn.json'),
    ).not.toThrow()
  })
})

describe('alias collisions', () => {
  // Two packages deriving one shim filename means one of them silently vanishes.
  test('rejects two packages that derive the same alias', () => {
    const error = expectCode(
      () =>
        validateManifest(
          { ...minimal, dependencies: { '@a/promise': '^1.0.0', '@b/promise': '^1.0.0' } },
          'rarn.json',
        ),
      Code.AliasCollision,
    )
    expect(error.detail).toContain('@a/promise')
    expect(error.detail).toContain('@b/promise')
    expect(error.how).toContain('aliases')
  })

  // The message has to say which section, because the same alias is fine in another
  // one and "2 packages would both be installed as 'Promise'" does not say where.
  test('the message names the section', () => {
    const error = expectCode(
      () =>
        validateManifest(
          { ...minimal, dependencies: { '@a/promise': '^1.0.0', '@b/promise': '^1.0.0' } },
          'rarn.json',
        ),
      Code.AliasCollision,
    )
    expect(error.what).toContain('dependencies')
  })

  /**
   * Root shims are written per section — `dependencies` into the shared realm
   * directory, `serverDependencies` into the server one — so two aliases only collide
   * when they came from the same section. Pooling all three refused an arrangement the
   * layout has no objection to, and a person reaches the two through different Roblox
   * services anyway.
   */
  test('the same alias in two sections is two files, not a collision', () => {
    expect(() =>
      validateManifest(
        {
          ...minimal,
          dependencies: { '@a/promise': '^1.0.0' },
          serverDependencies: { '@b/promise': '^1.0.0' },
        },
        'rarn.json',
      ),
    ).not.toThrow()
  })

  /**
   * `writeRootShims` says a package declared in two sections should be reachable from
   * both realm directories. Pooling the sections made that a collision of a package
   * with itself, so the linker's documented behaviour was unreachable.
   */
  test('one package declared in two sections is not a collision with itself', () => {
    expect(() =>
      validateManifest(
        {
          ...minimal,
          dependencies: { '@a/promise': '^1.0.0' },
          devDependencies: { '@a/promise': '^1.0.0' },
        },
        'rarn.json',
      ),
    ).not.toThrow()
  })

  test('an aliases override resolves the collision', () => {
    expect(() =>
      validateManifest(
        {
          ...minimal,
          dependencies: { '@a/promise': '^1.0.0', '@b/promise': '^1.0.0' },
          aliases: { '@b/promise': 'BPromise' },
        },
        'rarn.json',
      ),
    ).not.toThrow()
  })
})

describe('normalizeManifest', () => {
  test('fills defaults so downstream layers never encode one', () => {
    const n = normalizeManifest(minimal)
    expect(n.packageDir).toBe('RARN_MODULE')
    expect(n.realm).toBe('shared')
    expect(n.private).toBe(false)
    expect(n.dependencies).toEqual({})
    expect(n.resolutions).toEqual({})
  })

  test('does not overwrite what was declared', () => {
    expect(
      normalizeManifest({ ...minimal, packageDir: 'Packages', realm: 'server' }),
    ).toMatchObject({ packageDir: 'Packages', realm: 'server' })
  })
})

describe('serializeManifest', () => {
  test('writes a stable field order regardless of input order', () => {
    const text = serializeManifest({
      dependencies: { '@a/b': '^1.0.0' },
      version: '1.0.0',
      name: 'x',
    })
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>)
    expect(keys).toEqual(['name', 'version', 'dependencies'])
  })

  test('sorts dependencies so add produces a one-line diff', () => {
    const text = serializeManifest({
      ...minimal,
      dependencies: { '@z/z': '^1.0.0', '@a/a': '^1.0.0', '@m/m': '^1.0.0' },
    })
    const deps = (JSON.parse(text) as { dependencies: Record<string, string> }).dependencies
    expect(Object.keys(deps)).toEqual(['@a/a', '@m/m', '@z/z'])
  })

  test('ends with a newline', () => {
    expect(serializeManifest(minimal).endsWith('}\n')).toBe(true)
  })

  test('preserves a field this writer does not know about', () => {
    const text = serializeManifest({ ...minimal, futureField: 42 } as unknown as Manifest)
    expect(JSON.parse(text)).toMatchObject({ futureField: 42 })
  })

  test('is idempotent', () => {
    const once = serializeManifest(minimal)
    expect(serializeManifest(JSON.parse(once) as Manifest)).toBe(once)
  })
})

describe('withDependency / withoutDependency', () => {
  test('adds to the named section', () => {
    const next = withDependency(minimal, 'devDependencies', '@evaera/promise', '^4.0.0')
    expect(next.devDependencies).toEqual({ '@evaera/promise': '^4.0.0' })
    expect(next.dependencies).toBeUndefined()
  })

  // `rarn remove` should not need to be told which section holds the package.
  test('removes from whichever section holds it', () => {
    const start: Manifest = { ...minimal, serverDependencies: { '@a/b': '^1.0.0' } }
    const { manifest, removedFrom } = withoutDependency(start, '@a/b')
    expect(removedFrom).toEqual(['serverDependencies'])
    expect(manifest.serverDependencies).toEqual({})
  })

  test('reports removing nothing rather than pretending it worked', () => {
    expect(withoutDependency(minimal, '@a/b').removedFrom).toEqual([])
  })
})

describe('suggestPackageName', () => {
  test.each([
    ['/tmp/My Game', 'my-game'],
    ['/tmp/rarn', 'rarn'],
    ['/tmp/Some__Weird--Name', 'some-weird-name'],
  ])('%p becomes %p', (dir, expected) => {
    expect(suggestPackageName(dir)).toBe(expected)
  })
})

describe('readManifest', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarn-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('reads and normalizes', async () => {
    await writeFile(join(dir, 'rarn.json'), JSON.stringify(minimal))
    expect((await readManifest(dir)).packageDir).toBe('RARN_MODULE')
  })

  // A missing manifest is the one error that should teach the next command.
  test('a missing manifest suggests rarn init', async () => {
    const error = await expectCodeAsync(() => readManifest(dir), Code.ManifestNotFound)
    expect(error.how).toContain('rarn init')
  })

  test('bad JSON is reported as bad JSON, not as a schema failure', async () => {
    await writeFile(join(dir, 'rarn.json'), '{ "name": "x", }')
    const error = await expectCodeAsync(() => readManifest(dir), Code.ManifestUnreadable)
    expect(error.how).toContain('trailing comma')
  })

  test('round-trips through disk unchanged', async () => {
    const original: Manifest = { ...minimal, dependencies: { '@evaera/promise': '^4.0.0' } }
    const path = join(dir, 'rarn.json')
    await writeFile(path, serializeManifest(original))
    await readManifest(dir)
    expect(await readFile(path, 'utf8')).toBe(serializeManifest(original))
  })
})
