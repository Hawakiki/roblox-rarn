import { describe, expect, test } from 'bun:test'
import { Code, WarnCode } from '../src/util/codes.ts'
import { RarnError } from '../src/util/errors.ts'

const all = { ...Code, ...WarnCode }

describe('error codes', () => {
  // The whole point of a code is that it identifies one thing. Two names sharing a
  // number means a search for it lands on two unrelated problems, and the guarantee
  // is gone. This is the only invariant that actually has to hold.
  test('no number is used twice', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, code] of Object.entries(all)) {
      const previous = seen.get(code)
      if (previous === undefined) seen.set(code, name)
      else clashes.push(`${code} is used by both ${previous} and ${name}`)
    }
    expect(clashes).toEqual([])
  })

  test.each(Object.entries(all))('%s is well-formed', (_name, code) => {
    expect(code).toMatch(/^RN\d{4}$/)
  })

  test('codes are grouped by layer', () => {
    expect(Code.ManifestInvalid.slice(2, 3)).toBe('0')
    expect(Number.parseInt(Code.RegistryUnreachable.slice(2), 10)).toBeGreaterThanOrEqual(100)
    expect(Number.parseInt(Code.VersionConflict.slice(2), 10)).toBeGreaterThanOrEqual(200)
    expect(Number.parseInt(Code.IntegrityMismatch.slice(2), 10)).toBeGreaterThanOrEqual(300)
    expect(Number.parseInt(Code.LockfileInvalid.slice(2), 10)).toBeGreaterThanOrEqual(500)
  })
})

describe('RarnError.format', () => {
  test('leads with the code so it is the first thing to search for', () => {
    const error = new RarnError({ code: Code.VersionConflict, what: 'Two majors wanted.' })
    expect(error.format().startsWith('RN0210: ')).toBe(true)
  })

  test('renders where, detail and how in a fixed order', () => {
    const error = new RarnError({
      code: Code.ManifestInvalid,
      what: 'Manifest is invalid.',
      where: 'rarn.json',
      detail: 'dependencies must be an object',
      how: 'Fix the field and run again.',
    })
    const lines = error.format().split('\n')
    expect(lines[0]).toBe('RN0012: Manifest is invalid.')
    expect(lines[1]).toBe('  at rarn.json')
    expect(error.format().indexOf('dependencies must be')).toBeLessThan(
      error.format().indexOf('Fix the field'),
    )
  })

  test('omits the optional parts rather than printing empty labels', () => {
    const error = new RarnError({ code: Code.Unimplemented, what: 'Not done.' })
    expect(error.format()).toBe('RN0001: Not done.')
  })
})
