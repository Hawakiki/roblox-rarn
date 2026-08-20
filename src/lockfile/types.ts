import type { Realm } from '../manifest/types.ts'
import type { Placement } from '../resolver/types.ts'

/**
 * TypeScript mirror of `schemas/rarn.lock.schema.json`.
 *
 * The schema is the source of truth; this file follows it.
 */

export const LOCKFILE_VERSION = 1

export interface LockRequester {
  readonly from: string
  readonly range: string
}

export interface LockedPackage {
  readonly version: string
  readonly resolved: string
  readonly integrity: string
  readonly realm: Realm
  readonly placement?: Placement
  readonly moduleRoot?: string
  readonly indexDir?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly requestedBy?: readonly LockRequester[]
  readonly dev?: boolean
}

/** Everything in `rarn.json` that could change the resolution. */
export interface LockRoot {
  readonly name?: string
  readonly version?: string
  /** The manifest's index repository. Not the API URL at the top level. */
  readonly registry?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly serverDependencies?: Readonly<Record<string, string>>
  readonly resolutions?: Readonly<Record<string, string>>
}

export interface Lockfile {
  readonly lockfileVersion: number
  readonly registry: string
  readonly root: LockRoot
  readonly packages: Readonly<Record<string, LockedPackage>>
}

export const LOCKFILE_NAME = 'rarn.lock'
