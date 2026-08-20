/**
 * TypeScript mirror of `schemas/rarn.schema.json`.
 *
 * The schema is the source of truth; this file follows it. Change the schema first,
 * then these types, then the code — the reverse order produces a manifest that
 * validates but does not typecheck, or worse, the opposite.
 */

export type Realm = 'shared' | 'server'

/** `@scope/name` -> semver range. Ranges are npm syntax, never Cargo. */
export type DependencyMap = Readonly<Record<string, string>>

/** Where each package directory lands in the DataModel. */
export interface PlaceInfo {
  readonly sharedPackages?: string
  readonly serverPackages?: string
}

/** A manifest exactly as written on disk: everything optional is really optional. */
export interface Manifest {
  readonly $schema?: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly license?: string
  readonly authors?: readonly string[]
  readonly homepage?: string
  readonly repository?: string
  readonly private?: boolean
  readonly realm?: Realm
  readonly registry?: string
  readonly packageDir?: string
  readonly place?: PlaceInfo
  readonly dependencies?: DependencyMap
  readonly devDependencies?: DependencyMap
  readonly serverDependencies?: DependencyMap
  readonly resolutions?: Readonly<Record<string, string>>
  readonly aliases?: Readonly<Record<string, string>>
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}

/**
 * A manifest with defaults filled in.
 *
 * Downstream layers take this rather than `Manifest`, so that no one has to remember
 * that an absent `packageDir` means `RARN_MODULE` — the resolver and linker should
 * never carry knowledge of a default.
 */
export interface NormalizedManifest extends Manifest {
  readonly realm: Realm
  readonly registry: string
  readonly packageDir: string
  readonly private: boolean
  readonly place: PlaceInfo
  readonly dependencies: DependencyMap
  readonly devDependencies: DependencyMap
  readonly serverDependencies: DependencyMap
  readonly resolutions: Readonly<Record<string, string>>
  readonly aliases: Readonly<Record<string, string>>
}

export const MANIFEST_FILE_NAME = 'rarn.json'
export const LOCKFILE_FILE_NAME = 'rarn.lock'

export const DEFAULT_PACKAGE_DIR = 'RARN_MODULE'
export const DEFAULT_REGISTRY = 'https://github.com/UpliftGames/wally-index'
export const DEFAULT_REALM: Realm = 'shared'

/**
 * Directory names for each realm.
 *
 * Siblings rather than subdirectories, because each realm is synced to a different
 * Roblox service and no relative `script.Parent` walk can cross between them.
 */
export function realmDirs(packageDir: string): {
  shared: string
  server: string
  dev: string
} {
  return {
    shared: packageDir,
    server: `${packageDir}_SERVER`,
    dev: `${packageDir}_DEV`,
  }
}

/** The three dependency sections, in the order they should be shown to a user. */
export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'serverDependencies',
  'devDependencies',
] as const

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number]
