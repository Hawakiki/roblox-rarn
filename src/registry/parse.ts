import semver from 'semver'
import type { PlaceInfo, Realm } from '../manifest/types.ts'
import { Code } from '../util/codes.ts'
import { RegistryError } from '../util/errors.ts'
import { type PackageName, parseWallyName, toWallyName } from '../util/package-name.ts'
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

  const versions = wire.versions.map((entry) => parseVersion(name, entry))

  // Newest first, so callers never have to remember to sort. Prereleases stay in
  // the list — filtering them belongs to resolution, which knows whether a range
  // asked for one.
  const sorted = [...versions].sort((a, b) => semver.rcompare(a.version, b.version))
  return { name, versions: sorted }
}

function parseVersion(name: PackageName, entry: WireVersion): PackageVersion {
  const pkg = entry.package
  if (typeof pkg?.version !== 'string') {
    throw new RegistryError({
      code: Code.RegistryBadResponse,
      what: `A version entry for ${toWallyName(name)} has no version field.`,
      how: 'The registry returned data Rarn cannot read.',
    })
  }

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
