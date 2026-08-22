import { describe, expect, test } from 'bun:test'
import { scanSource, stripCommentsAndStrings } from '../src/doctor/scan.ts'

/** Aliases found at the given depth, sorted. */
const found = (source: string, depth: number) =>
  scanSource(source, depth)
    .dependencies.map((d) => d.alias)
    .sort()

describe('stripCommentsAndStrings', () => {
  // The reason this exists: Luau packages document themselves with example code, and
  // a scan that reads those examples reports requires that are not in the program.
  test('blanks a doc comment block', () => {
    const source = [
      '--[=[',
      '  local X = require(script.Parent.Parent.NotReal)',
      ']=]',
      'local Y = require(script.Parent.Parent.Real)',
    ].join('\n')

    expect(found(source, 1)).toEqual(['Real'])
  })

  test('blanks a line comment', () => {
    expect(
      found('-- require(script.Parent.Parent.Nope)\nrequire(script.Parent.Parent.Yes)', 1),
    ).toEqual(['Yes'])
  })

  test('blanks string bodies', () => {
    expect(found('local s = "require(script.Parent.Parent.Nope)"', 1)).toEqual([])
  })

  // Line numbers are how a finding gets located, so blanking must not shift them.
  test('preserves line numbers', () => {
    const source = '--[[\nmultiple\nlines\n]]\nrequire(script.Parent.Parent.Real)'
    expect(scanSource(source, 1).dependencies[0]?.line).toBe(5)
    expect(stripCommentsAndStrings(source).split('\n')).toHaveLength(5)
  })

  test('leaves ordinary code untouched', () => {
    expect(stripCommentsAndStrings('local x = 1').trim()).toBe('local x = 1')
  })
})

describe('depth', () => {
  // A dependency shim sits beside the module folder, so the number of .Parent hops
  // that reaches it depends on how deep inside the module the file is.
  test('init.lua reaches the shims with one Parent', () => {
    expect(found('require(script.Parent.Promise)', 0)).toEqual(['Promise'])
  })

  test('a sibling file needs two', () => {
    expect(found('require(script.Parent.Parent.Promise)', 1)).toEqual(['Promise'])
  })

  test('a file one folder down needs three', () => {
    expect(found('require(script.Parent.Parent.Parent.Promise)', 2)).toEqual(['Promise'])
  })

  // Not a dependency — the package addressing its own internals.
  test('a shallower reach is internal and ignored', () => {
    expect(found('require(script.Parent.Helper)', 1)).toEqual([])
    expect(found('require(script.Helper)', 1)).toEqual([])
  })

  test('a deeper reach is not a dependency either', () => {
    expect(found('require(script.Parent.Parent.Parent.Thing)', 1)).toEqual([])
  })

  test('bracket indexing works the same as a dot', () => {
    expect(found('require(script.Parent.Parent["Promise"])', 1)).toEqual(['Promise'])
  })
})

describe('lookup forms', () => {
  /**
   * The form the JS-port half of the registry uses. Every jsdotlua package — react-lua,
   * jest-lua, luau-polyfill — requires this way and nothing else, so a scanner that only
   * knew `.Foo` reported 1655 of 1663 requires in a real 52-package install as
   * unreadable, and then reported every dependency they reached as declared-but-unused.
   */
  test('reads :WaitForChild as an index', () => {
    expect(found("require(script.Parent.Parent:WaitForChild('Promise'))", 1)).toEqual(['Promise'])
  })

  test('reads :FindFirstChild as an index', () => {
    expect(found('require(script.Parent.Parent:FindFirstChild("Promise"))', 1)).toEqual(['Promise'])
  })

  test("WaitForChild's timeout argument does not hide the name", () => {
    expect(found("require(script.Parent.Parent:WaitForChild('Promise', 5))", 1)).toEqual([
      'Promise',
    ])
  })

  test('follows :WaitForChild through a tracked variable', () => {
    const source = ['local Util = script.Parent.Parent', "require(Util:WaitForChild('Promise'))"]
    expect(found(source.join('\n'), 1)).toEqual(['Promise'])
  })

  // Only the first step past the parent chain is the dependency. What follows is
  // inside whatever that step reached.
  test('takes the first step of a longer path', () => {
    expect(found('require(script.Parent.Parent.Promise.Some.Thing)', 1)).toEqual(['Promise'])
    expect(found("require(script.Parent.Parent:WaitForChild('a'):WaitForChild('b'))", 1)).toEqual([
      'a',
    ])
  })

  /**
   * Rojo names an instance by removing one extension, so `Foo.new.lua` becomes an
   * instance called `Foo.new` — react-lua has dozens. The string blanker treated the
   * dot as punctuation and erased the name, leaving a require with an empty argument.
   */
  test('a dot is part of an instance name, not punctuation', () => {
    expect(found("require(script.Parent.Parent:WaitForChild('Fiber.new'))", 1)).toEqual([
      'Fiber.new',
    ])
  })

  test('a variable whose name merely starts with script is not a chain', () => {
    const result = scanSource('require(scriptConfig.Promise)', 1)
    expect(result.dependencies).toHaveLength(0)
    expect(result.dynamic).toHaveLength(1)
  })

  // Luau's string require. Real, and genuinely unresolvable as an instance path —
  // these files run outside Roblox.
  test('a string require stays unreadable', () => {
    expect(scanSource('require("@pkg/@jsdotlua/react-test-renderer")', 1).dynamic).toHaveLength(1)
  })

  test('a bare parent with no lookup is unreadable, not a dependency', () => {
    const result = scanSource('require(script.Parent.Parent)', 1)
    expect(result.dependencies).toHaveLength(0)
    expect(result.dynamic).toHaveLength(1)
  })
})

describe('requires through a variable', () => {
  // sleitnick/knit does exactly this. A scanner that only matched the literal chain
  // would report the most used framework in the ecosystem as entirely dynamic.
  test('follows a local assigned a script chain', () => {
    const source = ['local Util = script.Parent.Parent', 'local P = require(Util.Promise)'].join(
      '\n',
    )
    expect(found(source, 1)).toEqual(['Promise'])
  })

  test('follows a field assignment', () => {
    const source = [
      'KnitClient.Util = script.Parent.Parent',
      'local Promise = require(KnitClient.Util.Promise)',
    ].join('\n')
    expect(found(source, 1)).toEqual(['Promise'])
  })

  // Knit's actual line, type cast and parentheses included.
  test('sees through a cast and the parentheses it forces', () => {
    const source = [
      'KnitClient.Util = (script.Parent :: Instance).Parent',
      'local Promise = require(KnitClient.Util.Promise)',
      'local Comm = require(KnitClient.Util.Comm)',
    ].join('\n')
    expect(found(source, 1)).toEqual(['Comm', 'Promise'])
  })

  test('a variable holding something else is not followed', () => {
    const source = ['local Util = someTable.Thing', 'require(Util.Promise)'].join('\n')
    expect(found(source, 1)).toEqual([])
    expect(scanSource(source, 1).dynamic).toHaveLength(1)
  })
})

describe('dynamic requires', () => {
  // The blind spot, reported rather than hidden.
  test('reports a require of a bare variable', () => {
    const result = scanSource('for _, v in pairs(x) do require(v) end', 1)
    expect(result.dependencies).toHaveLength(0)
    expect(result.dynamic).toHaveLength(1)
    expect(result.dynamic[0]?.expression).toBe('v')
  })

  test('reports a computed path', () => {
    expect(scanSource('require(folder[name])', 1).dynamic).toHaveLength(1)
  })

  test('counts each one separately', () => {
    expect(scanSource('require(a)\nrequire(b)\nrequire(c)', 1).dynamic).toHaveLength(3)
  })
})

describe('scanning realistic sources', () => {
  test('separates dependencies from internal navigation', () => {
    const source = [
      '--!strict',
      '--[=[',
      '  @class Knit',
      '  local Knit = require(somewhere.Knit)',
      ']=]',
      'local Promise = require(script.Parent.Parent.Promise)',
      'local Types = require(script.Parent.Types)',
      'local Util = script.Parent.Parent',
      'local Comm = require(Util.Comm)',
      'return { Promise = Promise, Types = Types, Comm = Comm }',
    ].join('\n')

    const result = scanSource(source, 1)
    expect(result.dependencies.map((d) => d.alias).sort()).toEqual(['Comm', 'Promise'])
    expect(result.dynamic).toHaveLength(0)
  })

  test('a module with no requires at all is quiet', () => {
    const result = scanSource('return function() return 1 end', 0)
    expect(result.dependencies).toHaveLength(0)
    expect(result.dynamic).toHaveLength(0)
  })

  test('records where each finding was', () => {
    const source = ['local a = 1', '', 'local P = require(script.Parent.Parent.Promise)'].join('\n')
    expect(scanSource(source, 1).dependencies[0]).toMatchObject({ alias: 'Promise', line: 3 })
  })

  test('an unterminated string does not hang the scanner', () => {
    expect(() => scanSource('local s = "oops', 1)).not.toThrow()
  })

  test('an unterminated comment does not hang the scanner', () => {
    expect(() => scanSource('--[[ oops', 1)).not.toThrow()
  })
})
