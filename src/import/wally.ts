import {
  DEFAULT_REGISTRY,
  type DependencySection,
  type Manifest,
  type PlaceInfo,
  type Realm,
  realmDirs,
} from '../manifest/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { deriveAlias, parseWallyName, toRarnName } from '../util/package-name.ts'
import { fromCargoRange } from '../util/version-range.ts'

/** Wally's install directories, measured by running `wally install`. */
export const WALLY_PACKAGE_DIR = 'Packages'
const WALLY_REALM_DIRS: Readonly<Record<'server' | 'dev', string>> = {
  server: 'ServerPackages',
  dev: 'DevPackages',
}

/** `[dependencies]` in wally.toml -> `dependencies` in rarn.json. */
const SECTIONS: readonly (readonly [string, DependencySection])[] = [
  ['dependencies', 'dependencies'],
  ['server-dependencies', 'serverDependencies'],
  ['dev-dependencies', 'devDependencies'],
]

/**
 * `[package]` keys Rarn understands.
 *
 * Anything else is reported rather than dropped in silence. An unknown key is
 * usually a typo — `licence`, `author` — and a typo that vanishes without comment
 * takes the field with it.
 */
const KNOWN_PACKAGE_KEYS = new Set([
  'name',
  'version',
  'registry',
  'realm',
  'description',
  'license',
  'authors',
  'homepage',
  'repository',
  'private',
  'include',
  'exclude',
])

export interface ImportedDependency {
  readonly section: DependencySection
  /** The key as written in wally.toml, which is the alias the author's code uses. */
  readonly alias: string
  /** `@scope/name`. */
  readonly name: string
  /** The requirement exactly as written. */
  readonly cargo: string
  /** The same requirement in npm syntax. */
  readonly range: string
  /** Whether the alias had to be recorded because Rarn would derive a different one. */
  readonly aliasKept: boolean
}

export interface WallyImport {
  readonly manifest: Manifest
  readonly dependencies: readonly ImportedDependency[]
  readonly warnings: readonly string[]
}

/**
 * Translates a `wally.toml` into a `rarn.json`.
 *
 * Pure: it takes the file's text and returns what should be written. Reading and
 * writing belong to the command, so the interesting half stays testable without a
 * filesystem.
 */
export function fromWallyToml(source: string, where: string): WallyImport {
  const root = parseToml(source, where)
  const pkg = section(root, 'package')

  if (pkg === undefined) {
    throw new RarnError({
      code: Code.WallyManifestInvalid,
      what: 'wally.toml has no [package] section.',
      where,
      how: 'Every Wally manifest needs [package] with at least a name and a version.',
    })
  }

  const warnings: string[] = []
  const wallyName = required(pkg, 'name', where)
  const name = toRarnName(parseWallyName(wallyName))
  const dependencies = collectDependencies(root, where, warnings)
  const authors = stringArray(pkg.authors)
  const include = stringArray(pkg.include)
  const exclude = stringArray(pkg.exclude)

  const manifest: Manifest = {
    name,
    version: required(pkg, 'version', where),
    ...optional(pkg, 'description'),
    ...optional(pkg, 'license'),
    ...optional(pkg, 'homepage'),
    ...optional(pkg, 'repository'),
    ...(authors === undefined ? {} : { authors }),
    ...(pkg.private === true ? { private: true } : {}),
    realm: realmOf(pkg.realm, warnings),
    registry: typeof pkg.registry === 'string' ? pkg.registry : DEFAULT_REGISTRY,

    // Wally's shared directory, not Rarn's default. The project being imported has a
    // Rojo file pointing at `Packages` already; renaming it here would mean a working
    // import whose very first sync finds nothing.
    packageDir: WALLY_PACKAGE_DIR,

    ...placeOf(root),
    ...sectionsOf(dependencies),
    ...aliasesOf(dependencies),
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  }

  warnAboutRealmDirs(dependencies, warnings)
  warnAboutUnknownKeys(pkg, warnings)

  return { manifest, dependencies, warnings }
}

function collectDependencies(
  root: Readonly<Record<string, unknown>>,
  where: string,
  warnings: string[],
): ImportedDependency[] {
  const found: ImportedDependency[] = []

  for (const [tomlSection, rarnSection] of SECTIONS) {
    const table = section(root, tomlSection)
    if (table === undefined) continue

    for (const [alias, raw] of Object.entries(table)) {
      if (typeof raw !== 'string') {
        warnings.push(`[${tomlSection}] ${alias} is not a string, so it was skipped.`)
        continue
      }

      // Split on the *first* '@' only. A Cargo requirement can hold commas and
      // spaces but never an '@', so everything after the first one is the range.
      const at = raw.indexOf('@')
      if (at === -1) {
        throw new RarnError({
          code: Code.WallyManifestInvalid,
          what: `[${tomlSection}] ${alias} = "${raw}" has no version requirement.`,
          where,
          how: "Wally dependencies look like 'evaera/promise@^4.0.0'.",
        })
      }

      const parsed = parseWallyName(raw.slice(0, at))
      const cargo = raw.slice(at + 1).trim()
      const name = toRarnName(parsed)

      found.push({
        section: rarnSection,
        alias,
        name,
        cargo,
        range: fromCargoRange(cargo),
        aliasKept: alias !== deriveAlias(parsed),
      })
    }
  }

  return found
}

function sectionsOf(deps: readonly ImportedDependency[]): Partial<Manifest> {
  const out: Record<string, Record<string, string>> = {}

  for (const dep of deps) {
    out[dep.section] ??= {}
    const target = out[dep.section]
    if (target !== undefined) target[dep.name] = dep.range
  }

  return out
}

/**
 * Records the aliases Rarn would not have guessed.
 *
 * The key in wally.toml is the name the author's own code requires by — `Packages.shared`,
 * not `Packages.Shared`. Rarn derives an alias by PascalCasing, which agrees with the
 * common style and disagrees with the rest: the whole `jsdotlua` family publishes
 * lowercase (`shared`, `math`, `luau-polyfill`). Dropping the difference would leave
 * every one of those requires pointing at nothing.
 */
function aliasesOf(deps: readonly ImportedDependency[]): Partial<Manifest> {
  const aliases: Record<string, string> = {}
  for (const dep of deps) {
    if (dep.aliasKept) aliases[dep.name] = dep.alias
  }
  return Object.keys(aliases).length === 0 ? {} : { aliases }
}

function placeOf(root: Readonly<Record<string, unknown>>): Partial<Manifest> {
  const table = section(root, 'place')
  if (table === undefined) return {}

  const shared = table['shared-packages']
  const server = table['server-packages']
  const place: PlaceInfo = {
    ...(typeof shared === 'string' ? { sharedPackages: shared } : {}),
    ...(typeof server === 'string' ? { serverPackages: server } : {}),
  }

  return Object.keys(place).length === 0 ? {} : { place }
}

/**
 * Warns when the realm directories will not match what Wally used.
 *
 * Wally installs into `Packages`, `ServerPackages` and `DevPackages` — three
 * independent names. Rarn derives its two extra realms from one setting by suffix,
 * so `Packages` gives `Packages_SERVER` and `Packages_DEV`. The shared directory
 * therefore lines up with the project's existing Rojo file and the other two do not,
 * which is worth one sentence now rather than an empty folder in Studio later.
 */
function warnAboutRealmDirs(deps: readonly ImportedDependency[], warnings: string[]): void {
  const dirs = realmDirs(WALLY_PACKAGE_DIR)

  for (const realm of ['server', 'dev'] as const) {
    const section = realm === 'server' ? 'serverDependencies' : 'devDependencies'
    if (!deps.some((dep) => dep.section === section)) continue

    warnings.push(
      `Wally put ${realm} packages in ${WALLY_REALM_DIRS[realm]}/; Rarn will use ${dirs[realm]}/. Point your Rojo project at the new directory.`,
    )
  }
}

function warnAboutUnknownKeys(pkg: Readonly<Record<string, unknown>>, warnings: string[]): void {
  const unknown = Object.keys(pkg).filter((key) => !KNOWN_PACKAGE_KEYS.has(key))
  if (unknown.length > 0) {
    warnings.push(
      `[package] has keys Rarn does not use, and they were dropped: ${unknown.join(', ')}.`,
    )
  }
}

function parseToml(source: string, where: string): Readonly<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(source)
  } catch (cause) {
    throw new RarnError({
      code: Code.WallyManifestInvalid,
      what: 'wally.toml could not be parsed as TOML.',
      where,
      detail: `  ${cause instanceof Error ? cause.message : String(cause)}`,
      how: 'Fix the syntax error, or run `wally install` to see Wally report it.',
      cause,
    })
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new RarnError({
      code: Code.WallyManifestInvalid,
      what: 'wally.toml is empty.',
      where,
      how: 'A Wally manifest needs at least a [package] section.',
    })
  }

  return parsed as Readonly<Record<string, unknown>>
}

function section(
  root: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = root[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

function required(pkg: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const value = pkg[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RarnError({
      code: Code.WallyManifestInvalid,
      what: `[package] ${key} is missing.`,
      where,
      how: 'Every Wally manifest needs a name and a version.',
    })
  }
  return value
}

function optional(pkg: Readonly<Record<string, unknown>>, key: string): Record<string, string> {
  const value = pkg[key]
  return typeof value === 'string' && value !== '' ? { [key]: value } : {}
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  return strings.length === 0 ? undefined : strings
}

/**
 * The registry only knows `shared` and `server`.
 *
 * An unknown value becomes `shared` with a warning rather than a refusal, matching
 * what `registry/parse.ts` does for the same field. Refusing to import a whole
 * project over one typo would be a hostile trade.
 */
function realmOf(value: unknown, warnings: string[]): Realm {
  if (value === 'server') return 'server'
  if (value === 'shared' || value === undefined) return 'shared'
  warnings.push(
    `[package] realm = ${JSON.stringify(value)} is not a realm Wally has; read as "shared".`,
  )
  return 'shared'
}
