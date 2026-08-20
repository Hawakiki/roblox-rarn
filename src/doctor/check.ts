import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createLayout } from '../linker/layout.ts'
import { INDEX_DIR_NAME } from '../linker/layout.ts'
import type { NormalizedManifest } from '../manifest/types.ts'
import type { Resolution } from '../resolver/types.ts'
import { pathExists } from '../util/fs.ts'
import { toIndexDir } from '../util/package-name.ts'
import { scanSource } from './scan.ts'

export interface PackageReport {
  readonly key: string
  /** Aliases the source requires that have no shim beside it — `nil` at runtime. */
  readonly missing: readonly { alias: string; file: string; line: number }[]
  /** Aliases declared in the lockfile that no source ever requires. */
  readonly unused: readonly string[]
  /** Requires whose target could not be determined statically. */
  readonly dynamic: number
  readonly filesScanned: number
}

export interface DoctorReport {
  readonly packages: readonly PackageReport[]
  readonly filesScanned: number
  readonly dynamicTotal: number
  readonly missingTotal: number
  readonly unusedTotal: number
}

/**
 * Cross-checks what each installed package *requires* against what it *declared*.
 *
 * A package that requires an alias it never declared gets `nil` back at runtime, and
 * nothing about the install looks wrong beforehand — no file is missing, no version
 * conflicts, the tree is exactly as the lockfile describes. The mismatch is only
 * visible by reading the source, which is what this does.
 *
 * The reverse case, a declared dependency nothing requires, is not a bug. It is worth
 * saying because it is usually a leftover, and it costs a download and an install
 * every time anyone uses the package.
 */
export async function runDoctor(
  projectDir: string,
  manifest: NormalizedManifest,
  resolution: Resolution,
): Promise<DoctorReport> {
  const layout = createLayout(projectDir, manifest)
  const packages: PackageReport[] = []

  for (const [key, pkg] of [...resolution.packages].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = join(
      layout.realms[pkg.placement],
      INDEX_DIR_NAME,
      toIndexDir(pkg.name, pkg.version),
    )
    if (!(await pathExists(entry))) continue

    const moduleRoot = await findModule(entry, pkg.name.name)
    if (moduleRoot === undefined) continue

    const declared = new Set(pkg.dependencies.keys())
    const required = new Map<string, { file: string; line: number }>()
    let dynamic = 0
    let filesScanned = 0

    for (const file of await luauFiles(moduleRoot.path)) {
      const source = await readFile(file, 'utf8').catch(() => null)
      if (source === null) continue

      filesScanned += 1
      const result = scanSource(source, depthOf(moduleRoot, file))
      dynamic += result.dynamic.length

      for (const finding of result.dependencies) {
        if (!required.has(finding.alias)) {
          required.set(finding.alias, {
            file: relative(projectDir, file),
            line: finding.line,
          })
        }
      }
    }

    const missing = [...required.entries()]
      .filter(([alias]) => !declared.has(alias))
      .map(([alias, where]) => ({ alias, ...where }))
      .sort((a, b) => a.alias.localeCompare(b.alias))

    const unused = [...declared].filter((alias) => !required.has(alias)).sort()

    if (missing.length > 0 || unused.length > 0 || dynamic > 0) {
      packages.push({ key, missing, unused, dynamic, filesScanned })
    }
  }

  return {
    packages,
    filesScanned: packages.reduce((sum, p) => sum + p.filesScanned, 0),
    dynamicTotal: packages.reduce((sum, p) => sum + p.dynamic, 0),
    missingTotal: packages.reduce((sum, p) => sum + p.missing.length, 0),
    unusedTotal: packages.reduce((sum, p) => sum + p.unused.length, 0),
  }
}

interface ModuleRoot {
  readonly path: string
  /** True when the whole module is one file rather than a directory. */
  readonly isFile: boolean
}

/** The package's own module, which is a directory or a single file beside the shims. */
async function findModule(entry: string, name: string): Promise<ModuleRoot | undefined> {
  const asDirectory = join(entry, name)
  if (await pathExists(asDirectory)) {
    const info = await stat(asDirectory)
    if (info.isDirectory()) return { path: asDirectory, isFile: false }
  }

  for (const extension of ['.luau', '.lua']) {
    const asFile = `${asDirectory}${extension}`
    if (await pathExists(asFile)) return { path: asFile, isFile: true }
  }

  return undefined
}

/**
 * How far inside the module a file's script sits.
 *
 * `init.lua` *is* the module, so it is depth 0; a sibling file is depth 1; a file one
 * folder further down is depth 2. That number decides how many `.Parent` hops reach
 * the shims, which is the whole basis for telling a dependency require apart from
 * the package addressing its own internals.
 */
function depthOf(root: ModuleRoot, file: string): number {
  if (root.isFile) return 0

  const segments = relative(root.path, file).split(sep)
  const isInit = /^init\.lua[u]?$/.test(segments.at(-1) ?? '')
  return segments.length - 1 + (isInit ? 0 : 1)
}

async function luauFiles(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => null)
  if (info === null) return []
  if (info.isFile()) return [root]

  const found: string[] = []
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (entries === null) continue

    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (/\.lua[u]?$/.test(entry.name)) found.push(path)
    }
  }

  return found.sort()
}
