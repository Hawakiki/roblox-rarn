import { describe, expect, test } from 'bun:test'
import { RarnError } from '../src/util/errors.ts'
import {
  areCompatible,
  bestVersionFor,
  normalizeRange,
  parsePackageReq,
} from '../src/util/version-range.ts'

describe('normalizeRange', () => {
  // The reason this module exists: Wally speaks Cargo, `semver` speaks npm.
  test.each([
    ['>=4.0.0, <5.0.0', '>=4.0.0 <5.0.0'],
    ['>=1.0.0,<2.0.0', '>=1.0.0 <2.0.0'],
    ['>= 1.0.0 ,  < 2.0.0', '>=1.0.0 <2.0.0'],
    ['^4.0.0', '^4.0.0'],
    ['~1.2.3', '~1.2.3'],
    ['*', '*'],
    ['  ^1.0.0  ', '^1.0.0'],
  ])('translates %p to %p', (input, expected) => {
    expect(normalizeRange(input)).toBe(expected)
  })

  test('a translated Cargo range keeps its original meaning', () => {
    const range = normalizeRange('>=4.0.0, <5.0.0')
    expect(bestVersionFor(['3.9.0', '4.0.0', '4.7.2', '5.0.0'], [range])).toBe('4.7.2')
  })

  // Guards the actual failure mode: an untranslated Cargo range does not throw,
  // it silently means something else. If this ever stops holding, the translation
  // has become unnecessary and this module should be revisited.
  test('an untranslated Cargo range parses to a different meaning', () => {
    const raw = '>=4.0.0, <5.0.0'
    expect(bestVersionFor(['4.7.2', '9.9.9'], [raw])).not.toBe(
      bestVersionFor(['4.7.2', '9.9.9'], [normalizeRange(raw)]),
    )
  })

  test.each(['', '   ', ',,', 'not-a-range', '^^4.0.0'])('rejects %p', (input) => {
    expect(() => normalizeRange(input)).toThrow(RarnError)
  })
})

describe('parsePackageReq', () => {
  test('splits on the first @ so comma ranges survive', () => {
    const req = parsePackageReq('evaera/promise@>=4.0.0, <5.0.0')
    expect(req.name).toEqual({ scope: 'evaera', name: 'promise' })
    expect(req.range).toBe('>=4.0.0 <5.0.0')
  })

  test('handles a plain caret range', () => {
    expect(parsePackageReq('sleitnick/knit@^1.7.0')).toEqual({
      name: { scope: 'sleitnick', name: 'knit' },
      range: '^1.7.0',
    })
  })

  test.each(['evaera/promise', 'evaera@^1.0.0'])('rejects %p', (input) => {
    expect(() => parsePackageReq(input)).toThrow(RarnError)
  })
})

describe('areCompatible', () => {
  test.each([
    ['1.2.0', '1.9.0', true],
    ['1.0.0', '2.0.0', false],
    ['0.2.0', '0.2.9', true],
    ['0.2.0', '0.3.0', false],
    ['4.0.0', '4.0.0', true],
  ])('%s vs %s -> %p', (a, b, expected) => {
    expect(areCompatible(a, b)).toBe(expected)
  })
})

describe('bestVersionFor', () => {
  const published = ['1.0.0', '1.2.0', '1.5.0', '1.9.0', '2.0.0']

  test('picks the highest version satisfying every range', () => {
    expect(bestVersionFor(published, ['^1.2.0'])).toBe('1.9.0')
  })

  // The case Wally's greedy resolver fails on. Intersecting first makes it trivial.
  test('unifies two overlapping ranges that greedy resolution would conflict on', () => {
    expect(bestVersionFor(published, ['^1.2.0', '^1.5.0'])).toBe('1.9.0')
  })

  test('returns null only when the ranges genuinely cannot both hold', () => {
    expect(bestVersionFor(published, ['^1.0.0', '^2.0.0'])).toBeNull()
  })

  test('ignores prereleases unless a range asks for them', () => {
    expect(bestVersionFor(['1.0.0', '2.0.0-rc.1'], ['*'])).toBe('1.0.0')
  })
})
