import { isAbsolute, join, relative, resolve } from 'node:path'
import type { NormalizedManifest } from '../manifest/types.ts'
import { realmDirs } from '../manifest/types.ts'
import type { Placement } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { isValidAlias } from '../util/package-name.ts'

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
 * Rejects a `packageDir` whose *shape* would make installing destructive.
 *
 * Installing wipes and rebuilds the realm directories, so this value decides what
 * gets deleted. The manifest schema's character class once permitted `"."`, which
 * would resolve the shared realm to the project root itself and delete the user's
 * entire project on the next install. Nothing about that failure would be
 * recoverable, so it is checked here as well as in the schema rather than trusting
 * one gate.
 *
 * **This guarantees the path, not the contents.** It once carried a comment saying
 * installing could only delete "Rarn's own directories", which was not true: the only
 * thing it enforces is a single directory name inside the project, and on Windows and
 * macOS a name does not even distinguish `Packages` from `packages`. A project whose
 * source lived in `packages/` had it replaced by the install — see RN-1. Whether the
 * directory actually belongs to Rarn is `ownership.ts`, and that check is the one
 * standing between an install and someone's source tree.
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

/**
 * `<dir>/<alias>.luau`, for an alias that cannot name anything else.
 *
 * Nothing should arrive here unchecked: the registry layer refuses what a package
 * declares and the manifest schema refuses what `aliases` says. This is the second
 * gate, for the same reason `assertSafePackageDir` is: `link` takes a resolution as an
 * argument, and whatever builds one next will not have read either of those checks.
 */
export function shimPath(dir: string, alias: string, owner: string): string {
  if (!isValidAlias(alias)) {
    // Not RN0112, which is the registry's refusal of a package. Reaching this means a
    // check that should have run did not, and that is what RN0003 reports everywhere.
    throw new RarnError({
      code: Code.InternalError,
      what: `${owner} would write a shim named ${JSON.stringify(alias)}, which is not a plain file name.`,
      where: owner,
      how: 'The install stopped before replacing anything. The name should have been refused when it was read, so this is a bug in Rarn: please report it.',
    })
  }
  return join(dir, `${alias}${SHIM_EXTENSION}`)
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
