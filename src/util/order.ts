/**
 * Orders strings by UTF-16 code unit — exactly what `.sort()` does with no comparator.
 *
 * The comparator that reads naturally, `localeCompare`, answers a question about the
 * machine rather than the strings. With no locale argument it collates by the
 * process's default locale, and locales disagree about plain ASCII: Czech sorts `ch`
 * after `h`, so `@acme/chalk` and `@acme/dog` trade places. Even in English it puts
 * `t` before `TestEZ` where `.sort()` does the opposite, so a lockfile whose `packages`
 * map was sorted one way and whose inner maps were sorted the other followed two rules
 * at once. Anything written to disk, published, printed as `--json`, or deciding which
 * of two things comes first is ordered this way instead.
 *
 * Code units rather than code points because matching `.sort()` is the point: the two
 * differ only for characters outside the Basic Multilingual Plane, which no package
 * name, alias or version can contain.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
