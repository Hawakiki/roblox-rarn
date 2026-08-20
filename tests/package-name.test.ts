import { describe, expect, test } from 'bun:test'
import { RarnError } from '../src/util/errors.ts'
import {
  deriveAlias,
  parsePackageName,
  parseWallyName,
  toIndexDir,
  toPackageKey,
  toRarnName,
  toWallyName,
} from '../src/util/package-name.ts'

const promise = { scope: 'evaera', name: 'promise' } as const

describe('parsing', () => {
  test('reads the manifest form', () => {
    expect(parsePackageName('@evaera/promise')).toEqual(promise)
  })

  test('reads the registry form', () => {
    expect(parseWallyName('evaera/promise')).toEqual(promise)
  })

  test('a missing @ is reported as a missing @, not as a missing scope', () => {
    expect(() => parsePackageName('evaera/promise')).toThrow(/leading '@'/)
  })

  test.each(['@evaera', '@/promise', '@evaera/', '@Evaera/promise', '@evaera/-promise'])(
    'rejects %p',
    (input) => {
      expect(() => parsePackageName(input)).toThrow(RarnError)
    },
  )
})

describe('rendering', () => {
  test('each form is produced from the same parts', () => {
    expect(toRarnName(promise)).toBe('@evaera/promise')
    expect(toWallyName(promise)).toBe('evaera/promise')
    expect(toPackageKey(promise, '4.0.0')).toBe('@evaera/promise@4.0.0')
    expect(toIndexDir(promise, '4.0.0')).toBe('evaera_promise@4.0.0')
  })

  test('round-trips through the registry form', () => {
    expect(parseWallyName(toWallyName(promise))).toEqual(promise)
  })
})

describe('deriveAlias', () => {
  test.each([
    ['promise', 'Promise'],
    ['roact', 'Roact'],
    ['knit', 'Knit'],
    ['some-lib', 'SomeLib'],
    ['a-b-c', 'ABC'],
  ])('%p becomes %p', (name, expected) => {
    expect(deriveAlias({ scope: 'x', name })).toBe(expected)
  })

  test('prefixes an underscore when the name would start a Luau identifier with a digit', () => {
    expect(deriveAlias({ scope: 'x', name: '2d-math' })).toBe('_2dMath')
  })

  // Collisions are why the manifest has an `aliases` override at all.
  test('two different packages can derive the same alias', () => {
    expect(deriveAlias({ scope: 'a', name: 'promise' })).toBe(
      deriveAlias({ scope: 'b', name: 'promise' }),
    )
  })
})
