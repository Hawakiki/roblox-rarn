import type { PlaceInfo, Realm } from '../manifest/types.ts'
import type { PackageName } from '../util/package-name.ts'
import type { PackageReq } from '../util/version-range.ts'

/**
 * Shapes the Wally registry actually sends, verified against the live API.
 *
 * Kept separate from the parsed types below because the wire format uses
 * kebab-case keys, `null` for absent values, and Cargo range syntax — none of
 * which should leak past this layer.
 */
export interface WireMetadata {
  versions: WireVersion[]
}

export interface WireVersion {
  /** Optional on purpose: the wire is untrusted, so the parser must check. */
  package?: WirePackage
  dependencies?: Record<string, string>
  'dev-dependencies'?: Record<string, string>
  'server-dependencies'?: Record<string, string>
  place?: {
    'shared-packages'?: string | null
    'server-packages'?: string | null
  }
}

export interface WirePackage {
  name: string
  version: string
  realm: string
  description?: string | null
  license?: string | null
  authors?: string[]
  homepage?: string | null
  repository?: string | null
  private?: boolean
  registry?: string
}

/** One published version, with every range already translated to npm syntax. */
export interface PackageVersion {
  readonly name: PackageName
  readonly version: string
  readonly realm: Realm
  /** Alias the package's own source requires, to the package and range it wants. */
  readonly dependencies: ReadonlyMap<string, PackageReq>
  readonly serverDependencies: ReadonlyMap<string, PackageReq>
  readonly devDependencies: ReadonlyMap<string, PackageReq>
  readonly place: PlaceInfo
  readonly description: string | undefined
  readonly license: string | undefined
}

/** Every published version of one package, newest first. */
export interface PackageMetadata {
  readonly name: PackageName
  readonly versions: readonly PackageVersion[]
}

export interface SearchResult {
  readonly name: PackageName
  readonly versions: readonly string[]
  readonly description: string | undefined
}

export interface RegistryClient {
  /** All published versions. Needs no auth and no version header. */
  getMetadata(name: PackageName): Promise<PackageMetadata>
  /** The package archive, as ZIP bytes. Requires the `Wally-Version` header. */
  getContents(name: PackageName, version: string): Promise<Uint8Array>
  search(query: string): Promise<readonly SearchResult[]>
}

/** The index repository Wally ships with, and the API its config.json points at. */
export const DEFAULT_INDEX_URL = 'https://github.com/UpliftGames/wally-index'
export const DEFAULT_API_URL = 'https://api.wally.run/'

/**
 * Value sent as `Wally-Version`.
 *
 * The registry rejects `package-contents` outright without this header, so it is
 * not optional. Wally sends its own crate version; anything the server considers
 * recent enough works, so this tracks the Wally release Rarn was verified against
 * rather than Rarn's own version.
 */
export const WALLY_VERSION_HEADER = '0.3.2'
