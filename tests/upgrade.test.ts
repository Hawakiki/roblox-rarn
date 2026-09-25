import { describe, expect, test } from 'bun:test'
import semver from 'semver'
import { rangeMentionsPrerelease } from '../src/resolver/select.ts'
import { type RangeUpgrade, upgradeRange, upgradeRanges } from '../src/resolver/upgrade.ts'
import { normalizeRange } from '../src/util/version-range.ts'

/**
 * The range `rarn up` writes back. The rule without `--latest` is one sentence — only
 * the floor moves — and every row below is a notation that sentence has to survive.
 */

const raised = (range: string): RangeUpgrade => ({ kind: 'raised', range })
const unchanged: RangeUpgrade = { kind: 'unchanged' }

describe('without --latest', () => {
  const rows: [string, string[], RangeUpgrade][] = [
    // The two shapes from the report.
    ['~1.2.0', ['2.0.0', '1.3.0', '1.2.5', '1.2.0'], raised('~1.2.5')],
    ['>=1.0.0 <1.5.0', ['2.0.0', '1.5.0', '1.4.2', '1.0.0'], raised('>=1.4.2 <1.5.0')],

    // Operators keep their notation.
    ['^1.2.0', ['2.0.0', '1.9.0', '1.2.0'], raised('^1.9.0')],
    ['^0.2.0', ['0.3.0', '0.2.5', '0.2.0'], raised('^0.2.5')],
    ['~1.2', ['1.3.0', '1.2.5', '1.2.0'], raised('~1.2.5')],
    ['^1', ['2.0.0', '1.9.0', '1.0.0'], raised('^1.9.0')],

    // Explicit bounds: the floor is replaced, the ceiling is kept as written.
    ['>1.0.0 <=1.5.0', ['1.6.0', '1.4.2', '1.0.0'], raised('>=1.4.2 <=1.5.0')],
    ['<1.5.0', ['1.5.0', '1.4.2', '1.0.0'], raised('>=1.4.2 <1.5.0')],
    ['>=1.0.0', ['3.1.0', '1.0.0'], raised('>=3.1.0')],
    ['1.0.0 - 1.5.0', ['1.6.0', '1.4.2', '1.0.0'], raised('1.4.2 - 1.5.0')],
    // Not `1.0.0 - 1.2.2`: read with prereleases, as the resolver reads, a hyphen's
    // floor becomes `>=1.0.0-0`, below the `1.0.0-rc.1` the person wrote.
    ['1.0.0-rc.1 - 1.2.2', ['1.2.3', '1.0.0'], raised('>=1.0.0 <=1.2.2')],
    // Written the way someone arriving from wally.toml would.
    ['>= 1.0.0, <1.5.0', ['1.5.0', '1.4.2', '1.0.0'], raised('>=1.4.2 <1.5.0')],

    // No floor in the notation, so the equivalent one that has one.
    ['1.x', ['2.0.0', '1.9.0', '1.0.0'], raised('^1.9.0')],
    ['1.2.x', ['1.3.0', '1.2.5', '1.2.0'], raised('~1.2.5')],
    ['*', ['3.1.0', '1.0.0'], raised('>=3.1.0')],
    ['^1.0.0 || ^2.0.0', ['2.3.0', '2.0.0', '1.0.0'], raised('^2.3.0')],
    // The same union the other way round. Cut at 2.3.0, `^1.0.0` is empty, and
    // `semver.subset` rejects an empty alternative that follows a non-empty one.
    ['^2.0.0 || ^1.0.0', ['2.3.0', '2.0.0', '1.0.0'], raised('^2.3.0')],
    // `~1` means the same as `^1`, and a tilde on 1.9.0 would stop at 1.10.0.
    ['~1', ['2.0.0', '1.9.0', '1.0.0'], raised('^1.9.0')],

    // Nothing to raise.
    ['1.2.3', ['1.2.4', '1.2.3'], unchanged],
    ['=1.2.3', ['1.2.4', '1.2.3'], unchanged],
    ['^1.9.0', ['2.0.0', '1.9.0'], unchanged],
    // Already there in a shorter spelling; rewriting it would be noise in a diff.
    ['^1.9', ['1.9.0'], unchanged],
    ['^5.0.0', ['1.0.0'], unchanged],
    ['^1.0.0', ['1.1.0-rc.1', '1.0.0'], unchanged],

    // No single operator says both bounds, so they are written out. A caret on 0.5.2
    // would stop at 0.6.0; `<1` is the ceiling `^0` always had.
    ['^0', ['1.0.0', '0.5.2', '0.1.0'], raised('>=0.5.2 <1')],
    ['0.x', ['1.0.0', '0.5.2', '0.1.0'], raised('>=0.5.2 <1')],
    ['^1.2.0 <1.5.0', ['1.5.0', '1.4.2', '1.2.0'], raised('>=1.4.2 <1.5.0')],
    // A union is cut one alternative at a time: below the floor goes, above it stays
    // as written, and only the one that straddles it is rewritten.
    ['^2.0.0 || ^3.0.0', ['2.3.0', '2.0.0'], raised('>=2.3.0 <3 || ^3.0.0')],
    ['>=1.0.0 <1.5.0 || >=2.0.0 <2.5.0', ['2.5.0', '2.3.0', '1.4.2'], raised('>=2.3.0 <2.5.0')],
    // Alternatives that start at or above the floor, which `semver.subset` does not
    // confirm: it reads `>1.2.2` in intervals, as reaching below `>=1.2.3`, and the other
    // two admit a prerelease by name that `>=floor` excludes. Asked, it left all three
    // unraised.
    ['1.x || >1.2.2 <=2.3.1', ['1.2.3', '1.0.0'], raised('>=1.2.3 <2 || >1.2.2 <=2.3.1')],
    ['^1.0.0 || ^2.0.0-0', ['1.5.0', '1.0.0'], raised('>=1.5.0 <2 || ^2.0.0-0')],
    ['<=1.2 || 2.3.1-rc.1', ['1.2.0', '1.0.0'], raised('>=1.2.0 <1.3 || 2.3.1-rc.1')],
    // `<1.0.0-0` is the same ceiling, but the resolver reads any range naming a
    // prerelease as asking for prereleases, and would then take 0.6.0-rc.1.
    ['^0', ['0.6.0-rc.1', '0.5.2', '0.1.0'], raised('>=0.5.2 <1')],
  ]

  test.each(rows)('%s', (declared, published, expected) => {
    expect(upgradeRange(declared, published, false)).toEqual(expected)
  })

  /**
   * The property the rows are instances of, checked on every one of them: nothing the
   * declared range excluded is admitted, and nothing it admitted from the newest
   * allowed version upward is lost.
   */
  test.each(rows.filter(([, , expected]) => expected.kind === 'raised'))(
    '%s neither widens nor narrows',
    (declared, published) => {
      const upgrade = upgradeRange(declared, published, false)
      if (upgrade.kind !== 'raised') throw new Error('expected a rewrite')

      const range = normalizeRange(declared)
      const newest = semver.maxSatisfying(published, range) ?? ''
      const probes = [...published, '0.0.1', '0.9.0', '1.1.0', '1.4.9', '1.99.0', '9.0.0']
      for (const version of probes) {
        const before = semver.satisfies(version, range) && semver.gte(version, newest)
        expect([version, semver.satisfies(version, upgrade.range)]).toEqual([version, before])
      }
    },
  )

  /**
   * The resolver reads differently from the check above: it counts prereleases, and it
   * only looks at them for a package once some range names one. So a rewrite may not
   * name a prerelease the declared range did not, and under the resolver's reading it
   * may still admit nothing the declared range excluded.
   */
  test.each(rows.filter(([, , expected]) => expected.kind === 'raised'))(
    '%s stays inside the declared range as the resolver reads it',
    (declared, published) => {
      const upgrade = upgradeRange(declared, published, false)
      if (upgrade.kind !== 'raised') throw new Error('expected a rewrite')

      const range = normalizeRange(declared)
      const optsIn = rangeMentionsPrerelease(upgrade.range) && !rangeMentionsPrerelease(range)
      expect(optsIn).toBe(false)

      const probes = ['0.6.0-rc.1', '1.0.0-0', '1.4.2-rc.1', '1.5.0-rc.1', '2.0.0-rc.1', '3.0.0-0']
      for (const version of [...published, ...probes]) {
        if (!semver.satisfies(version, upgrade.range, { includePrerelease: true })) continue
        expect([version, semver.satisfies(version, range, { includePrerelease: true })]).toEqual([
          version,
          true,
        ])
      }
    },
  )

  test('never offers a prerelease, even when it is the newest in range', () => {
    expect(upgradeRange('^1.0.0', ['1.2.0-rc.1', '1.1.0', '1.0.0'], false)).toEqual(
      raised('^1.1.0'),
    )
  })
})

/**
 * One package declared in more than one section. The resolver installs those ranges
 * together, so they are raised together, each to the version an install would give it.
 */
describe('several ranges on one package', () => {
  const rows: [string[], string[], RangeUpgrade[]][] = [
    // Raised one at a time, each caret would rise past what the range beside it allows —
    // to `^1.3.0` and to `^1.5.0` — leaving no version in common.
    [
      ['^1.2.0', '~1.2.0'],
      ['2.0.0', '1.3.0', '1.2.5', '1.2.0'],
      [raised('^1.2.5'), raised('~1.2.5')],
    ],
    [
      ['^1.0.0', '>=1.0.0 <1.5.0'],
      ['2.0.0', '1.5.0', '1.4.2', '1.0.0'],
      [raised('^1.4.2'), raised('>=1.4.2 <1.5.0')],
    ],
    // Two majors are two installs, so there is nothing to agree on. Requiring every
    // range to hold at once would find no version and leave both where they were.
    [
      ['^1.0.0', '^2.0.0'],
      ['2.3.0', '2.0.0', '1.9.0', '1.0.0'],
      [raised('^1.9.0'), raised('^2.3.0')],
    ],
    // Already in conflict before `up`: the install reports it either way, and a rewrite
    // would have to guess which side was meant.
    [
      ['~1.2.0', '^1.5.0'],
      ['1.9.0', '1.2.5', '1.2.0'],
      [unchanged, unchanged],
    ],
  ]

  test.each(rows)('%p', (declared, published, expected) => {
    expect(upgradeRanges(declared, published, false)).toEqual(expected)
  })

  test.each(rows)('%p still installs as one version wherever it did', (declared, published) => {
    const after = upgradeRanges(declared, published, false).map((upgrade, index) =>
      upgrade.kind === 'raised' ? upgrade.range : normalizeRange(declared[index] ?? ''),
    )
    const shared = (ranges: string[]): string | null =>
      semver.maxSatisfying(published, ranges.join(' '))
    expect(shared(after) === null).toBe(
      shared(declared.map((range) => normalizeRange(range))) === null,
    )
  })

  test('with --latest, every range names the same newest release', () => {
    expect(upgradeRanges(['^1.2.0', '~1.2.0'], ['2.0.0', '1.3.0', '1.2.0'], true)).toEqual([
      raised('^2.0.0'),
      raised('~2.0.0'),
    ])
  })
})

describe('with --latest', () => {
  const published = ['3.0.0-rc.1', '2.0.0', '1.9.0', '1.2.5', '1.2.3', '1.2.0']

  const rows: [string, RangeUpgrade][] = [
    ['^1.2.0', raised('^2.0.0')],
    ['~1.2.0', raised('~2.0.0')],
    ['1.2.3', raised('2.0.0')],
    ['=1.2.3', raised('=2.0.0')],
    // No single operator to keep, and the bounds are what --latest ignores.
    ['>=1.0.0 <1.5.0', raised('^2.0.0')],
    ['1.x', raised('^2.0.0')],
    ['^1.0.0 || ^0.1.0', raised('^2.0.0')],
    ['^2.0.0', unchanged],
    ['^2', unchanged],
  ]

  test.each(rows)('%s', (declared, expected) => {
    expect(upgradeRange(declared, published, true)).toEqual(expected)
  })

  test('changes nothing when only prereleases are published', () => {
    expect(upgradeRange('^1.0.0', ['2.0.0-rc.1', '1.0.0-beta.1'], true)).toEqual(unchanged)
  })
})
