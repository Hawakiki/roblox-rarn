import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEPENDENCY_SECTIONS, type NormalizedManifest } from '../manifest/types.ts'
import type { Resolution } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { byCodeUnit } from '../util/order.ts'
import {
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  type LockRoot,
  type LockedPackage,
  type Lockfile,
} from './types.ts'

export interface BuildLockfileOptions {
  manifest: NormalizedManifest
  resolution: Resolution
  /** API base every `resolved` URL points at. */
  registry: string
  /** Package key -> sha256 of the downloaded archive. */
  integrity: ReadonlyMap<string, string>
  /** Package key -> module root chosen by pruning. Recorded for inspection only. */
  moduleRoots?: ReadonlyMap<string, string>
}

/**
 * Turns a finished install into the lockfile that reproduces it.
 *
 * Every map is written in sorted order. That is the whole reason the file is
 * reviewable: object key order in JSON is insertion order, so without sorting, two
 * runs that resolved identically would still produce different bytes and every
 * install would show up as a diff.
 */
export function buildLockfile(options: BuildLockfileOptions): Lockfile {
  const { manifest, resolution, registry, integrity, moduleRoots } = options

  const packages: Record<string, LockedPackage> = {}

  for (const key of [...resolution.packages.keys()].sort()) {
    const pkg = resolution.packages.get(key)
    if (pkg === undefined) continue

    const digest = integrity.get(key)
    if (digest === undefined) {
      throw new RarnError({
        code: Code.InternalError,
        what: `No integrity digest was recorded for ${key}.`,
        how: 'This is a bug in Rarn. Please report it.',
      })
    }

    const moduleRoot = moduleRoots?.get(key)
    packages[key] = {
      version: pkg.version,
      resolved: contentsUrl(registry, pkg.name.scope, pkg.name.name, pkg.version),
      integrity: digest,
      realm: pkg.realm,
      placement: pkg.placement,
      ...(moduleRoot === undefined || moduleRoot === '' ? {} : { moduleRoot }),
      indexDir: `${pkg.name.scope}_${pkg.name.name}@${pkg.version}`,
      dependencies: sortRecord(Object.fromEntries(pkg.dependencies)),
      requestedBy: [...pkg.requestedBy]
        .map((c) => ({ from: c.from, range: c.range }))
        .sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.range, b.range)),
      dev: pkg.dev,
    }
  }

  return {
    lockfileVersion: LOCKFILE_VERSION,
    registry,
    root: buildRoot(manifest),
    packages,
  }
}

/**
 * Snapshots only what could change the resolution.
 *
 * `packageDir`, `place` and `aliases` are deliberately left out: they change where
 * files land, not which versions are chosen, and linking runs on every install
 * anyway. Including them would invalidate the lockfile — and force a full
 * re-resolution over the network — every time someone renamed a directory.
 */
function buildRoot(manifest: NormalizedManifest): LockRoot {
  const root: { -readonly [K in keyof LockRoot]: LockRoot[K] } = {
    name: manifest.name,
    version: manifest.version,
    registry: manifest.registry,
  }

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section]
    if (Object.keys(deps).length > 0) root[section] = sortRecord(deps)
  }
  if (Object.keys(manifest.resolutions).length > 0) {
    root.resolutions = sortRecord(manifest.resolutions)
  }

  return root
}

/** Serializes with a stable shape and a trailing newline. */
export function serializeLockfile(lockfile: Lockfile): string {
  return `${JSON.stringify(lockfile, null, 2)}\n`
}

export async function writeLockfile(dir: string, lockfile: Lockfile): Promise<void> {
  const path = join(resolve(dir), LOCKFILE_NAME)
  try {
    await writeFile(path, serializeLockfile(lockfile), 'utf8')
  } catch (cause) {
    throw new RarnError({
      code: Code.LockfileInvalid,
      what: `Could not write ${LOCKFILE_NAME}.`,
      where: path,
      how: 'Check that the file is not read-only and the directory is writable.',
      cause,
    })
  }
}

/** Where the archive for a package came from, recorded so it can be audited. */
function contentsUrl(registry: string, scope: string, name: string, version: string): string {
  return new URL(`v1/package-contents/${scope}/${name}/${version}`, registry).toString()
}

function sortRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => byCodeUnit(a, b)))
}
