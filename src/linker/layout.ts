import { isAbsolute, join, relative, resolve } from 'node:path'
import type { NormalizedManifest } from '../manifest/types.ts'
import { realmDirs } from '../manifest/types.ts'
import type { Placement } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'

/** Folder that holds one entry per resolved package version. */
export const INDEX_DIR_NAME = '_Index'

/** Generated shims use `.luau`; Wally writes `.lua`, and both load fine. */
export const SHIM_EXTENSION = '.luau'

export interface InstallLayout {
  readonly projectDir: string
  /** Absolute directory for each realm. Siblings, never nested. */
  readonly realms: Readonly<Record<Placement, string>>
}

export function createLayout(projectDir: string, manifest: NormalizedManifest): InstallLayout {
  const packageDir = assertSafePackageDir(projectDir, manifest.packageDir)
  const dirs = realmDirs(packageDir)
  const root = resolve(projectDir)

  return {
    projectDir: root,
    realms: {
      shared: join(root, dirs.shared),
      server: join(root, dirs.server),
      dev: join(root, dirs.dev),
    },
  }
}

/**
 * Rejects a `packageDir` that would make installing destructive.
 *
 * Installing wipes and rebuilds the realm directories, so this value decides what
 * gets deleted. The manifest schema's character class once permitted `"."`, which
 * would resolve the shared realm to the project root itself and delete the user's
 * entire project on the next install. Nothing about that failure would be
 * recoverable, so it is checked here as well as in the schema rather than trusting
 * one gate.
 */
export function assertSafePackageDir(projectDir: string, packageDir: string): string {
  const root = resolve(projectDir)
  const target = resolve(root, packageDir)
  const inside = relative(root, target)

  const unsafe =
    packageDir.trim() === '' ||
    inside === '' ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    inside.includes('/') ||
    inside.includes('\\')

  if (unsafe) {
    throw new RarnError({
      code: Code.ManifestInvalid,
      what: `"packageDir" is ${JSON.stringify(packageDir)}, which Rarn refuses to install into.`,
      where: 'rarn.json',
      how: 'It must be a single directory name inside the project, such as "RARN_MODULE". Installing deletes and rebuilds that directory, so it can never be the project root.',
    })
  }

  return packageDir
}

/** `<realm>/_Index` */
export function indexDir(layout: InstallLayout, placement: Placement): string {
  return join(layout.realms[placement], INDEX_DIR_NAME)
}

/**
 * `<realm>/_Index/<scope>_<name>@<version>`
 *
 * A package's own module folder and the shims for its dependencies both live here,
 * as siblings. That is not a layout choice: package sources reach their dependencies
 * with `script.Parent.Parent.Alias`, so the shim has to sit beside the module folder
 * or the require lands on nothing.
 */
export function entryDir(
  layout: InstallLayout,
  placement: Placement,
  indexDirName: string,
): string {
  return join(indexDir(layout, placement), indexDirName)
}
