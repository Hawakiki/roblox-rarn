import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEPENDENCY_SECTIONS, type NormalizedManifest } from '../manifest/types.ts'
import { pruneInto } from '../project/prune.ts'
import type { Placement, Resolution, ResolvedPackage } from '../resolver/types.ts'
import { SECTION_PLACEMENT } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { deriveAlias, parsePackageName, toIndexDir, toWallyName } from '../util/package-name.ts'
import {
  INDEX_DIR_NAME,
  type InstallLayout,
  SHIM_EXTENSION,
  createLayout,
  entryDir,
} from './layout.ts'
import { crossRealmShim, requirePlacePath, rootShim, siblingShim } from './shim.ts'

export interface LinkOptions {
  projectDir: string
  manifest: NormalizedManifest
  resolution: Resolution
  /** Package key -> directory holding that package's extracted archive. */
  sources: ReadonlyMap<string, string>
}

export interface LinkResult {
  readonly layout: InstallLayout
  /** Realms that actually received something. */
  readonly usedRealms: readonly Placement[]
  readonly shims: number
  readonly archiveFiles: number
  readonly installedFiles: number
  /** Non-fatal notes from project-file interpretation, keyed by package. */
  readonly notes: ReadonlyMap<string, string>
}

/**
 * Writes the install tree.
 *
 * Every realm directory is deleted and rebuilt rather than updated in place. An
 * incremental update has to work out which entries are now orphaned, and getting
 * that wrong leaves a stale package that still resolves — far worse than the cost of
 * recopying from a warm cache, which is only a file copy.
 */
export async function link(options: LinkOptions): Promise<LinkResult> {
  const { projectDir, manifest, resolution, sources } = options
  const layout = createLayout(projectDir, manifest)

  await Promise.all(
    Object.values(layout.realms).map((dir) => rm(dir, { recursive: true, force: true })),
  )

  const used = new Set<Placement>()
  const notes = new Map<string, string>()
  let archiveFiles = 0
  let installedFiles = 0

  // Sorted so that a rerun writes in the same order and any failure reports the
  // same package first.
  const packages = [...resolution.packages.entries()].sort(([a], [b]) => a.localeCompare(b))

  for (const [key, pkg] of packages) {
    const source = sources.get(key)
    if (source === undefined) {
      throw new RarnError({
        code: Code.LinkTargetMissing,
        what: `${key} was resolved but never downloaded.`,
        how: 'This is a bug in Rarn. Please report it.',
      })
    }

    used.add(pkg.placement)
    const dir = entryDir(layout, pkg.placement, indexDirNameOf(pkg))
    await mkdir(dir, { recursive: true })

    const result = await pruneInto(source, join(dir, moduleNameOf(pkg)), key)
    archiveFiles += result.archiveFiles
    installedFiles += result.installedFiles
    if (result.root.note !== undefined) notes.set(key, result.root.note)
  }

  let shims = 0
  shims += await writeDependencyShims(layout, manifest, resolution, packages)
  shims += await writeRootShims(layout, manifest, resolution, used)

  return {
    layout,
    usedRealms: [...used],
    shims,
    archiveFiles,
    installedFiles,
    notes,
  }
}

/**
 * Writes, beside each package's module folder, one shim per dependency it declares.
 *
 * Keyed by the alias the package's *own source* uses, not by anything Rarn derives —
 * the code says `require(...Promise)`, so the file has to be called `Promise`.
 */
async function writeDependencyShims(
  layout: InstallLayout,
  manifest: NormalizedManifest,
  resolution: Resolution,
  packages: readonly (readonly [string, ResolvedPackage])[],
): Promise<number> {
  let written = 0

  for (const [key, pkg] of packages) {
    const dir = entryDir(layout, pkg.placement, indexDirNameOf(pkg))
    const moduleName = moduleNameOf(pkg)

    for (const [alias, depKey] of [...pkg.dependencies].sort(([a], [b]) => a.localeCompare(b))) {
      const dep = resolution.packages.get(depKey)
      if (dep === undefined) {
        throw new RarnError({
          code: Code.LinkTargetMissing,
          what: `${key} depends on ${depKey}, which is not in the resolution.`,
          how: 'This is a bug in Rarn. Please report it.',
        })
      }

      // A dependency alias that collides with the package's own module folder would
      // put two instances of the same name in one parent, and one would win silently.
      if (alias === moduleName) {
        throw new RarnError({
          code: Code.AliasCollision,
          what: `${key} requires a dependency under the name '${alias}', which is also its own module name.`,
          detail: `  both would be installed as ${INDEX_DIR_NAME}/${indexDirNameOf(pkg)}/${alias}`,
          how: 'This package cannot be installed as published. Please report it to its author.',
        })
      }

      await writeFile(
        join(dir, `${alias}${SHIM_EXTENSION}`),
        shimFor(pkg.placement, dep, manifest, key),
        'utf8',
      )
      written += 1
    }
  }

  return written
}

/**
 * Writes the shims a person actually requires: `RARN_MODULE.Promise`.
 *
 * Driven by the manifest sections rather than by resolved placement, because a
 * package declared in two sections should be reachable from both realm directories
 * even though it is only stored once.
 */
async function writeRootShims(
  layout: InstallLayout,
  manifest: NormalizedManifest,
  resolution: Resolution,
  used: Set<Placement>,
): Promise<number> {
  let written = 0

  for (const section of DEPENDENCY_SECTIONS) {
    const placement = SECTION_PLACEMENT[section]
    const entries = Object.keys(manifest[section]).sort()
    if (entries.length === 0) continue

    await mkdir(layout.realms[placement], { recursive: true })
    used.add(placement)

    for (const rarnName of entries) {
      const name = parsePackageName(rarnName)
      const pkg = findResolved(resolution, toWallyName(name))
      if (pkg === undefined) continue

      const alias = manifest.aliases[rarnName] ?? deriveAlias(name)
      const source =
        pkg.placement === placement
          ? rootShim(indexDirNameOf(pkg), moduleNameOf(pkg))
          : crossRealmShim(
              requirePlacePath(manifest.place, pkg.placement, `rarn.json (${section})`),
              indexDirNameOf(pkg),
              moduleNameOf(pkg),
            )

      await writeFile(join(layout.realms[placement], `${alias}${SHIM_EXTENSION}`), source, 'utf8')
      written += 1
    }
  }

  return written
}

function shimFor(
  from: Placement,
  dep: ResolvedPackage,
  manifest: NormalizedManifest,
  requester: string,
): string {
  if (dep.placement === from) {
    return siblingShim(indexDirNameOf(dep), moduleNameOf(dep))
  }
  return crossRealmShim(
    requirePlacePath(manifest.place, dep.placement, requester),
    indexDirNameOf(dep),
    moduleNameOf(dep),
  )
}

/**
 * Picks the resolved package for a direct dependency.
 *
 * With two majors installed the manifest's own range decides which the top-level
 * shim points at; the one the root asked for is the right default because the
 * manifest is what asked for it in the first place.
 */
function findResolved(resolution: Resolution, wallyName: string): ResolvedPackage | undefined {
  const matches = [...resolution.packages.values()].filter(
    (pkg) => toWallyName(pkg.name) === wallyName,
  )
  return matches.find((pkg) => pkg.requestedBy.some((c) => c.from === 'root')) ?? matches[0]
}

/** `evaera_promise@4.0.0` */
function indexDirNameOf(pkg: ResolvedPackage): string {
  return toIndexDir(pkg.name, pkg.version)
}

/**
 * The instance name of a package's own module.
 *
 * Taken from the package name, not from `default.project.json`. The two always agree
 * because the registry rewrites the project file's `name` at publish time, but the
 * package name is the one that actually decides — reading it from the project file
 * would break for any package that has none, which is half of them.
 */
function moduleNameOf(pkg: ResolvedPackage): string {
  return pkg.name.name
}
