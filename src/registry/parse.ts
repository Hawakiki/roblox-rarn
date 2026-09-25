import semver from 'semver'
import type { PlaceInfo, Realm } from '../manifest/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError, RegistryError } from '../util/errors.ts'
import {
  type PackageName,
  isExactVersion,
  isValidAlias,
  parseWallyName,
  toWallyName,
} from '../util/package-name.ts'
import { type PackageReq, parsePackageReq } from '../util/version-range.ts'
import type { PackageMetadata, PackageVersion, WireMetadata, WireVersion } from './types.ts'

/**
 * Turns a registry response into Rarn's own types.
 *
 * Everything the wire format does differently stops here: kebab-case keys, `null`
 * for absent values, and — the one that matters — **Cargo range syntax**. A range
 * that escapes this layer untranslated does not throw, it silently means something
 * else, so every range is pushed through `parsePackageReq` on the way in.
 */
export function parseMetadata(name: PackageName, body: unknown): PackageMetadata {
  const wire = body as WireMetadata
  if (!Array.isArray(wire.versions)) {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: `The registry returned an unexpected shape for ${toWallyName(name)}.`,
      how: 'Expected a { "versions": [...] } object. The registry may be misconfigured.',
    })
  }

  const versions = wire.versions
    .map((entry) => parseVersion(name, entry))
    .filter((version) => version !== undefined)

  // Newest first, so callers never have to remember to sort. Prereleases stay in
  // the list — filtering them belongs to resolution, which knows whether a range
  // asked for one.
  const sorted = [...versions].sort((a, b) => semver.rcompare(a.version, b.version))
  return { name, versions: sorted }
}

function parseVersion(name: PackageName, entry: WireVersion): PackageVersion | undefined {
  const pkg = entry.package
  if (typeof pkg?.version !== 'string') {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: `A version entry for ${toWallyName(name)} has no version field.`,
      how: 'The registry returned data Rarn cannot read.',
    })
  }

  // Left out rather than refused. The version becomes a folder name and a lockfile
  // field, and one outside the lockfile schema's rule is a lockfile install writes and
  // then cannot read. The registry holds two (wally-index, 2026-09-25):
  // kampfkarren/react-roblox-act 0.0.0-001, beside five good versions, and yesavnd/iris
  // 2.4.1-090425. semver cannot parse either, so no range could have selected them, and
  // refusing the package would cost the other five for nothing — 0.0.0-001 used to
  // reach the sort below and throw a bare TypeError instead. The forms semver would take
  // and this does not, `v1.0.0` and padded ones, appear nowhere in the registry.
  //
  // The grammar alone does not make that sort safe. semver also refuses a component past
  // Number.MAX_SAFE_INTEGER and a version longer than 256 characters, by throwing. The
  // grammar admits both, and so does the Rust semver Wally's backend parses with (0.11:
  // u64 components, no documented length limit). None is published today (wally-index,
  // 2026-09-25); one would bring the TypeError back. `valid` rather than
  // `valid(v) === v`, for the build-metadata reason `isExactVersion` gives.
  if (!isExactVersion(pkg.version) || semver.valid(pkg.version) === null) return undefined

  const subject = `${toWallyName(name)}@${pkg.version}`
  assertAliases(entry.dependencies, subject, 'dependencies')
  assertAliases(entry['server-dependencies'], subject, 'server-dependencies')

  return {
    name,
    version: pkg.version,
    realm: parseRealm(pkg.realm),
    dependencies: parseDependencyMap(entry.dependencies),
    serverDependencies: parseDependencyMap(entry['server-dependencies']),
    devDependencies: parseDependencyMap(entry['dev-dependencies']),
    place: parsePlace(entry.place),
    description: nullToUndefined(pkg.description),
    license: nullToUndefined(pkg.license),
  }
}

/**
 * The registry only ever declares `shared` or `server`.
 *
 * An unknown value is treated as `shared` rather than rejected: refusing to install
 * because one package in the graph carries a realm this build has not heard of would
 * be a hostile failure for something the user cannot fix.
 */
function parseRealm(value: unknown): Realm {
  return value === 'server' ? 'server' : 'shared'
}

/**
 * Refuses a dependency alias that would name some file other than its own shim.
 *
 * The linker writes `<alias>.luau` beside the package's module folder, and the registry
 * checks nothing about the alias — Wally's backend reads wally.toml's dependency keys as
 * plain strings. So `"../../../../src/Main"` can be published, and it used to replace
 * the project's own `src/Main.luau` with a shim while the install reported success.
 *
 * The whole response is refused, not only the offending version, which is how a
 * malformed range anywhere in it is already treated. No alias the registry holds today
 * is refused, so the width costs nothing yet.
 *
 * `dev-dependencies` are not checked. Nothing reads a registry package's
 * dev-dependencies — they are not resolved, linked or shown, and Wally does not install
 * them either — so refusing a package over one would fail an install for a file that
 * was never going to exist. Should that change, `shimPath` still refuses the name at
 * the one place it would become a path.
 */
function assertAliases(
  raw: Record<string, string> | undefined,
  subject: string,
  section: string,
): void {
  for (const [alias, spec] of Object.entries(raw ?? {})) {
    if (isValidAlias(alias)) continue
    // Not a `RegistryError`, which exits as worth retrying: the registry answered with
    // exactly what was published, and it will answer the same way every time.
    throw new RarnError({
      code: Code.UnsafeDependencyAlias,
      what: `${subject} declares a dependency under the name ${JSON.stringify(alias)}, which Rarn will not use as a file name.`,
      where: subject,
      // Quoted as JSON so a trailing space or a newline in the name is visible.
      detail: `  [${section}] ${JSON.stringify(alias)} = ${JSON.stringify(spec)}`,
      how: "Each dependency is installed as a file named after it, so the name may use only letters, digits, '_' and '-', and may not start with '-'. Rarn refuses every version of the package over it, not only this one. Please report it to the package's author.",
    })
  }
}

/** `{ "Promise": "evaera/promise@>=4.0.0, <5.0.0" }` -> alias -> parsed request. */
function parseDependencyMap(
  raw: Record<string, string> | undefined,
): ReadonlyMap<string, PackageReq> {
  const map = new Map<string, PackageReq>()
  for (const [alias, spec] of Object.entries(raw ?? {})) {
    map.set(alias, parsePackageReq(spec))
  }
  return map
}

function parsePlace(raw: WireVersion['place']): PlaceInfo {
  const shared = nullToUndefined(raw?.['shared-packages'])
  const server = nullToUndefined(raw?.['server-packages'])
  return {
    ...(shared === undefined ? {} : { sharedPackages: shared }),
    ...(server === undefined ? {} : { serverPackages: server }),
  }
}

function nullToUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === '' ? undefined : value
}

/**
 * Reads the package identity from a search result.
 *
 * Search does **not** match the rest of the API: `package-metadata` reports a
 * package as one `"scope/name"` string, but `package-search` splits it into
 * separate `scope` and `name` fields. Verified against the live endpoint:
 *
 *     {"description":"WonderKnit","name":"knit","scope":"acecateer","versions":["1.7.2"]}
 *
 * Both shapes are accepted so that a registry following either convention works.
 */
export function parseSearchName(entry: unknown, context: string): PackageName {
  const row = entry as { name?: unknown; scope?: unknown }

  if (typeof row.scope === 'string' && typeof row.name === 'string') {
    return parseWallyName(`${row.scope}/${row.name}`)
  }

  if (typeof row.name === 'string' && row.name.includes('/')) {
    return parseWallyName(row.name)
  }

  throw new RegistryError({
    code: Code.RegistryBadResponse,
    what: `The registry returned an entry with no usable package name in ${context}.`,
    how: 'Expected either a "scope" and "name" pair, or a "scope/name" string.',
  })
}
