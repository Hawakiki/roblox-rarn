import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEPENDENCY_SECTIONS, type NormalizedManifest } from '../manifest/types.ts'
import { pruneInto } from '../project/prune.ts'
import type { Placement, Resolution, ResolvedPackage } from '../resolver/types.ts'
import { SECTION_PLACEMENT } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import {
  FILE_READ_CONCURRENCY,
  PRUNE_CONCURRENCY,
  mapWithConcurrency,
} from '../util/concurrency.ts'
import { RarnError } from '../util/errors.ts'
import { deriveAlias, parsePackageName, toIndexDir, toWallyName } from '../util/package-name.ts'
import {
  INDEX_DIR_NAME,
  type InstallLayout,
  SHIM_EXTENSION,
  createLayout,
  entryDir,
} from './layout.ts'
import { assertRealmsAreOurs } from './ownership.ts'
import { assertCrossable, crossRealmShim, requirePlacePath, rootShim, siblingShim } from './shim.ts'
import { STAGING_DIR, clearRetired, clearStaging, swapIn } from './swap.ts'
import { type TypeExport, readTypeExports } from './type-exports.ts'

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
  /**
   * Module root pruning chose for each package, keyed by package key.
   *
   * Recorded for the lockfile and for `rarn why`. Empty string means the archive
   * root was used, which is the normal case for a package that publishes clean.
   */
  readonly moduleRoots: ReadonlyMap<string, string>
}

/**
 * Writes the install tree.
 *
 * Every realm directory is rebuilt from scratch rather than updated in place. An
 * incremental update has to work out which entries are now orphaned, and getting
 * that wrong leaves a stale package that still resolves — far worse than the cost of
 * recopying from a warm cache, which is only a file copy.
 *
 * The rebuild happens in a staging directory and is renamed into place at the end.
 * Deleting first and writing over the top is the same amount of work right up until
 * something interrupts it, at which point the difference is the user's whole install:
 * with staging they keep the tree they had, without it they keep neither.
 */
export async function link(options: LinkOptions): Promise<LinkResult> {
  const final = createLayout(options.projectDir, options.manifest)

  // Before anything is moved, and before the staging tree is built: installing
  // replaces these directories, so the one question worth asking first is whether
  // they are Rarn's to replace.
  await assertRealmsAreOurs(final)

  // The build writes into the staging directory, so clearing it has to finish first.
  await clearStaging(final.projectDir)

  // Deleting the previous install's retired tree does not. Started here and awaited
  // below, it runs while the new tree is being copied out of the cache instead of after
  // it — on a repeat install of 506 packages that is 2,049ms of 6,517ms which nothing
  // was overlapping, because the delete was the last thing in the install.
  const retiring = clearRetired(final.projectDir)

  // The staged tree is built at a different root, which is only safe because no shim
  // ever names a filesystem path — they are `script.Parent…` walks or DataModel paths
  // out of `place`. If that ever stops being true, this stops working.
  const token = randomUUID().slice(0, 8)
  const layout = createLayout(join(final.projectDir, STAGING_DIR), options.manifest)

  try {
    return await build(final, layout, token, options)
  } finally {
    // A failed build has already left a partial tree in here. Removing it is not
    // optional politeness: the next run would clear it anyway, but until then the
    // user is looking at a directory full of half-installed packages that nothing
    // explains. Errors are swallowed so cleanup cannot replace the real failure.
    await rm(join(final.projectDir, STAGING_DIR), { recursive: true, force: true }).catch(
      () => undefined,
    )

    // Awaited on both paths rather than left floating. It cannot reject — `clearRetired`
    // swallows — so this only ever costs the remainder of a delete the build did not
    // outlast, and it keeps the install from ending with filesystem work still in
    // flight, which is a thing a caller has no way to see and no way to wait for.
    await retiring
  }
}

async function build(
  final: InstallLayout,
  layout: InstallLayout,
  token: string,
  options: LinkOptions,
): Promise<LinkResult> {
  const { manifest, resolution, sources } = options

  const used = new Set<Placement>()
  const notes = new Map<string, string>()
  const moduleRoots = new Map<string, string>()
  const entries: { key: string; destination: string; isFile: boolean }[] = []
  let archiveFiles = 0
  let installedFiles = 0

  // Sorted so that a rerun writes in the same order and any failure reports the
  // same package first.
  const packages = [...resolution.packages.entries()].sort(([a], [b]) => a.localeCompare(b))

  // Copied a few at a time rather than one after another. Each package writes into its
  // own `_Index/{scope}_{name}@{version}` directory and two packages resolving to one
  // version share that entry by key, so no two workers ever target the same path —
  // which is what makes this safe against constraint 1 rather than merely fast.
  //
  // The results are consumed in input order, not completion order, so the lockfile, the
  // shim contents and the reported counts are all identical to what the serial loop
  // produced — and `mapWithConcurrency` reports the lowest-indexed failure rather than
  // the fastest, so the sort above still buys what it was written to buy.
  const pruned = await mapWithConcurrency(packages, PRUNE_CONCURRENCY, async ([key, pkg]) => {
    const source = sources.get(key)
    if (source === undefined) {
      throw new RarnError({
        code: Code.LinkTargetMissing,
        what: `${key} was resolved but never downloaded.`,
        how: 'This is a bug in Rarn. Please report it.',
      })
    }

    const dir = entryDir(layout, pkg.placement, indexDirNameOf(pkg))
    await mkdir(dir, { recursive: true })

    return await pruneInto(source, join(dir, moduleNameOf(pkg)), key)
  })

  for (const [index, [key, pkg]] of packages.entries()) {
    const result = pruned[index]
    if (result === undefined) continue

    used.add(pkg.placement)
    archiveFiles += result.archiveFiles
    installedFiles += result.installedFiles
    moduleRoots.set(key, result.root.path)
    if (result.root.note !== undefined) notes.set(key, result.root.note)

    entries.push({ key, destination: result.destination, isFile: result.root.kind === 'file' })
  }

  // Read from the pruned tree rather than the archive, because `pruneInto` is what
  // knows whether the module became a directory or a single file. Once per package
  // rather than once per shim — three requesters share one read — and after the loop
  // rather than inside it: these are independent, and doing them in turn on a
  // 52-package install cost 225ms of nothing but waiting.
  const typeExports = new Map(
    await mapWithConcurrency(entries, FILE_READ_CONCURRENCY, async (entry) => {
      return [entry.key, await readTypeExports(entry.destination, entry.isFile)] as const
    }),
  )

  let shims = 0
  shims += await writeDependencyShims(layout, manifest, resolution, packages, typeExports)
  shims += await writeRootShims(layout, manifest, resolution, used, typeExports)

  await swapIn(final, layout, token)

  return {
    // The final layout, not the staging one. Callers print these paths and `rarn why`
    // reads them; a staging path in either would name a directory that no longer exists.
    layout: final,
    usedRealms: [...used],
    shims,
    archiveFiles,
    installedFiles,
    notes,
    moduleRoots,
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
  typeExports: ReadonlyMap<string, readonly TypeExport[]>,
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
        shimFor(pkg.placement, dep, manifest, key, typeExports.get(depKey) ?? []),
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
  typeExports: ReadonlyMap<string, readonly TypeExport[]>,
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
      const found = findResolved(resolution, toWallyName(name))
      if (found === undefined) continue
      const [key, pkg] = found

      const alias = manifest.aliases[rarnName] ?? deriveAlias(name)
      const types = typeExports.get(key) ?? []
      const source =
        pkg.placement === placement
          ? rootShim(indexDirNameOf(pkg), moduleNameOf(pkg), types)
          : crossRealmShim(
              requirePlacePath(
                manifest.place,
                assertCrossable(pkg.placement, `rarn.json (${section})`),
                `rarn.json (${section})`,
              ),
              indexDirNameOf(pkg),
              moduleNameOf(pkg),
              types,
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
  types: readonly TypeExport[],
): string {
  if (dep.placement === from) {
    return siblingShim(indexDirNameOf(dep), moduleNameOf(dep), types)
  }
  return crossRealmShim(
    requirePlacePath(manifest.place, assertCrossable(dep.placement, requester), requester),
    indexDirNameOf(dep),
    moduleNameOf(dep),
    types,
  )
}

/**
 * Picks the resolved package for a direct dependency.
 *
 * With two majors installed the manifest's own range decides which the top-level
 * shim points at; the one the root asked for is the right default because the
 * manifest is what asked for it in the first place.
 */
function findResolved(
  resolution: Resolution,
  wallyName: string,
): readonly [string, ResolvedPackage] | undefined {
  // The key comes back with the package rather than being rebuilt from its fields:
  // the format belongs to the resolver, and a second place that knows it is a second
  // place to get it wrong.
  const matches = [...resolution.packages].filter(([, pkg]) => toWallyName(pkg.name) === wallyName)
  return matches.find(([, pkg]) => pkg.requestedBy.some((c) => c.from === 'root')) ?? matches[0]
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
