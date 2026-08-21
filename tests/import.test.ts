import { describe, expect, test } from 'bun:test'
import { fromWallyToml } from '../src/import/wally.ts'
import { Code } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'

const WHERE = '/project/wally.toml'

function importToml(source: string) {
  return fromWallyToml(source, WHERE)
}

function expectRejection(source: string): RarnError {
  try {
    importToml(source)
  } catch (error) {
    expect(error).toBeInstanceOf(RarnError)
    return error as RarnError
  }
  throw new Error('expected a rejection but the import succeeded')
}

const MINIMAL = `
[package]
name = "hawakiki/thing"
version = "1.0.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"
`

/**
 * The published manifest of `sleitnick/comm@1.0.1`, byte for byte.
 *
 * Real rather than invented, because the thing most likely to be wrong here is an
 * assumption about how people actually write these files — and every requirement in
 * this one is a bare version, which is the form an invented fixture would not have
 * thought to use.
 */
const COMM = `
[package]
name = "sleitnick/comm"
description = "Comm library for remote communication"
version = "1.0.1"
license = "MIT"
authors = ["Stephen Leitnick"]
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
Signal = "sleitnick/signal@2"
Option = "sleitnick/option@1"
Promise = "evaera/promise@4"
`

describe('package section', () => {
  test('carries the identity across, scoping the name', () => {
    const { manifest } = importToml(COMM)
    expect(manifest.name).toBe('@sleitnick/comm')
    expect(manifest.version).toBe('1.0.1')
    expect(manifest.license).toBe('MIT')
    expect(manifest.description).toBe('Comm library for remote communication')
    expect(manifest.authors).toEqual(['Stephen Leitnick'])
    expect(manifest.realm).toBe('shared')
  })

  // Not Rarn's RARN_MODULE default: the project being imported already has a Rojo
  // file pointing at `Packages`, and an import whose first sync finds nothing is not
  // much of an import.
  test('keeps Wally’s package directory', () => {
    expect(importToml(COMM).manifest.packageDir).toBe('Packages')
  })

  test('keeps the registry verbatim, casing included', () => {
    const lowercase = MINIMAL.replace('UpliftGames', 'upliftgames')
    expect(importToml(lowercase).manifest.registry).toBe(
      'https://github.com/upliftgames/wally-index',
    )
  })

  test('carries include and exclude', () => {
    const source = `${MINIMAL}
exclude = ["*"]
include = ["lib", "default.project.json", "wally.toml"]
`
    const { manifest } = importToml(source)
    expect(manifest.exclude).toEqual(['*'])
    expect(manifest.include).toEqual(['lib', 'default.project.json', 'wally.toml'])
  })

  test('an unknown key is reported rather than dropped in silence', () => {
    const { warnings } = importToml(`${MINIMAL}\nlicence = "MIT"\n`)
    expect(warnings.join('\n')).toContain('licence')
  })

  // Matching registry/parse.ts, which reads an unknown realm as shared rather than
  // refusing. Refusing to import a whole project over one typo is a bad trade.
  test('an unknown realm becomes shared, with a warning', () => {
    const { manifest, warnings } = importToml(MINIMAL.replace('"shared"', '"client"'))
    expect(manifest.realm).toBe('shared')
    expect(warnings.join('\n')).toContain('client')
  })
})

describe('version requirements', () => {
  // The whole reason this milestone is risky. Cargo reads a bare version as a caret
  // requirement; npm reads it as an exact pin. Verified against the live registry:
  // this manifest declares `evaera/promise@4` and the index stored `>=4.0.0, <5.0.0`.
  test('a bare version becomes a caret, not an exact pin', () => {
    const { manifest } = importToml(COMM)
    expect(manifest.dependencies).toEqual({
      '@evaera/promise': '^4',
      '@sleitnick/option': '^1',
      '@sleitnick/signal': '^2',
    })
  })

  test('a bare full version too — the case that actually diverges', () => {
    const source = `${MINIMAL}
[dependencies]
Signal = "sleitnick/signal@2.0.0"
`
    // npm would read '2.0.0' as 2.0.0 exactly. Wally installs 2.0.3 for this line;
    // so does Rarn, which is the only reason the two agree.
    expect(importToml(source).manifest.dependencies).toEqual({ '@sleitnick/signal': '^2.0.0' })
  })

  test.each([
    ['^1.2.6', '^1.2.6'],
    ['~1.2.3', '~1.2.3'],
    ['=1.2.3', '=1.2.3'],
    ['>=1.0.0, <2.0.0', '>=1.0.0 <2.0.0'],
    ['>= 1.0.0, < 2.0.0', '>=1.0.0 <2.0.0'],
    ['*', '*'],
    ['1.*', '1.*'],
    ['1.2.3-beta.1', '^1.2.3-beta.1'],
  ])('%p becomes %p', (cargo, expected) => {
    const source = `${MINIMAL}\n[dependencies]\nX = "a/b@${cargo}"\n`
    expect(importToml(source).manifest.dependencies).toEqual({ '@a/b': expected })
  })

  test('a dependency with no requirement is refused rather than guessed at', () => {
    const error = expectRejection(`${MINIMAL}\n[dependencies]\nX = "a/b"\n`)
    expect(error.code).toBe(Code.WallyManifestInvalid)
  })
})

describe('aliases', () => {
  // The key in wally.toml is what the author's own code requires by. Rarn derives an
  // alias by PascalCasing, which agrees with `Promise` and disagrees with the whole
  // jsdotlua family — dropping the difference breaks every one of those requires.
  test('a key Rarn would not have derived is recorded', () => {
    const source = `${MINIMAL}
[dependencies]
shared = "jsdotlua/shared@17.2.1"
"luau-polyfill" = "jsdotlua/luau-polyfill@^1.2.6"
`
    const { manifest } = importToml(source)
    expect(manifest.aliases).toEqual({
      '@jsdotlua/shared': 'shared',
      '@jsdotlua/luau-polyfill': 'luau-polyfill',
    })
  })

  test('a key Rarn would have derived anyway is left out', () => {
    // Every key in COMM is the PascalCased name, so there is nothing to record and
    // the manifest should not grow an aliases map full of identities.
    expect(importToml(COMM).manifest.aliases).toBeUndefined()
  })
})

describe('realms', () => {
  test('each section lands in its own map', () => {
    const source = `${MINIMAL}
[dependencies]
Promise = "evaera/promise@^4"

[server-dependencies]
Signal = "sleitnick/signal@^2"

[dev-dependencies]
T = "osyrisrblx/t@^3"
`
    const { manifest } = importToml(source)
    expect(manifest.dependencies).toEqual({ '@evaera/promise': '^4' })
    expect(manifest.serverDependencies).toEqual({ '@sleitnick/signal': '^2' })
    expect(manifest.devDependencies).toEqual({ '@osyrisrblx/t': '^3' })
  })

  // Wally uses three independent directory names; Rarn derives two of its three from
  // one setting by suffix. Only the shared one lines up, and the mismatch shows up as
  // an empty folder in Studio rather than as an error.
  test('warns that the server and dev directories will be named differently', () => {
    const source = `${MINIMAL}
[server-dependencies]
Signal = "sleitnick/signal@^2"

[dev-dependencies]
T = "osyrisrblx/t@^3"
`
    const text = importToml(source).warnings.join('\n')
    expect(text).toContain('ServerPackages')
    expect(text).toContain('Packages_SERVER')
    expect(text).toContain('DevPackages')
    expect(text).toContain('Packages_DEV')
  })

  test('says nothing about directories a project does not use', () => {
    expect(importToml(COMM).warnings).toEqual([])
  })
})

describe('place', () => {
  test('maps the kebab-case keys onto Rarn’s', () => {
    const source = `${MINIMAL}
[place]
shared-packages = "game.ReplicatedStorage.Packages"
server-packages = "game.ServerScriptService.Packages"
`
    expect(importToml(source).manifest.place).toEqual({
      sharedPackages: 'game.ReplicatedStorage.Packages',
      serverPackages: 'game.ServerScriptService.Packages',
    })
  })

  test('is absent when the project declares none', () => {
    expect(importToml(COMM).manifest.place).toBeUndefined()
  })
})

describe('refusals', () => {
  test('a file that is not TOML', () => {
    const error = expectRejection('this is not [ toml')
    expect(error.code).toBe(Code.WallyManifestInvalid)
    expect(error.where).toBe(WHERE)
  })

  test('no [package] section', () => {
    const error = expectRejection('[dependencies]\nX = "a/b@1"\n')
    expect(error.code).toBe(Code.WallyManifestInvalid)
  })

  test('no version', () => {
    const error = expectRejection('[package]\nname = "a/b"\n')
    expect(error.code).toBe(Code.WallyManifestInvalid)
    expect(error.what).toContain('version')
  })
})
