import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import semver from 'semver'
import { INDEX_DIR_NAME, findProjectFiles } from '../project/place.ts'
import { byCodeUnit } from '../util/order.ts'
import { toRarnName } from '../util/package-name.ts'
import { areCompatible } from '../util/version-range.ts'

/**
 * Finds packages that appear at more than one version inside a single DataModel.
 *
 * Every other check Rarn makes is scoped to one project, and that is the blind spot
 * this exists to cover. Constraint 1's boundary is a Lua environment — one DataModel —
 * and a DataModel is built by a Rojo project file, which is free to mount trees from
 * anywhere. Two projects installed side by side and synced into one place each resolve
 * correctly, each report `no duplicates`, and produce two ModuleScript instances of
 * the same package with separate state.
 *
 * Measured, with `rojo sourcemap` on the tree the two installs produced:
 *
 * ```
 * ws.ReplicatedStorage.Alpha._Index.evaera_promise@3.2.0.promise
 * ws.ReplicatedStorage.Beta._Index.evaera_promise@3.2.1.promise
 * ```
 *
 * Nothing in Rarn could see that, because nothing in Rarn looked past one manifest.
 * This reads the project files instead of the lockfiles, so it sees whatever Rojo
 * will: a Wally install counts, and so does a tree Rarn did not create.
 *
 * **It reports, it does not resolve.** The fix is a decision about project layout —
 * converge the ranges, or mount the trees into different places — and neither is
 * Rarn's to make.
 */

export interface TreeVersion {
  /** Install directory, relative to the scan root. */
  readonly dir: string
  readonly version: string
}

export interface PlaceDuplicate {
  /** Manifest-shaped name: `@evaera/promise`. */
  readonly name: string
  /**
   * Whether two of these versions are semver-compatible.
   *
   * Incompatible versions in one DataModel are the arrangement Wally allows and Rarn
   * keeps — two majors really are two packages. Compatible ones are the singleton
   * hazard, and the only reason this check exists.
   */
  readonly compatible: boolean
  /** Newest first. */
  readonly versions: readonly TreeVersion[]
}

export interface PlaceReport {
  /** The project file that builds this DataModel, relative to the scan root. */
  readonly project: string
  /** Install directories it mounts, relative to the scan root. */
  readonly installs: readonly string[]
  readonly duplicates: readonly PlaceDuplicate[]
}

export interface PlacesScan {
  /** Directory the search started from — a repository root where one was found. */
  readonly root: string
  readonly places: readonly PlaceReport[]
}

/** How far up to look for a repository root before giving up and using the parent. */
const MAX_ASCENT = 5

/**
 * Deeper than the `place` derivation, because the search starts higher.
 *
 * `place` is derived from files at or below the project; this starts at the repository
 * root, so the same project files are one or two levels further down.
 */
const MAX_DEPTH = 5

export async function scanPlaces(
  projectDir: string,
  realmDirNames: readonly string[],
): Promise<PlacesScan> {
  const root = await searchRoot(projectDir)
  const skip = new Set([...realmDirNames, INDEX_DIR_NAME])
  const files = await findProjectFiles(root, skip, MAX_DEPTH)

  // The question is what shares a DataModel with *this* project's packages, not what
  // duplicates exist somewhere nearby. Without this the search wanders: a sibling
  // directory with its own unrelated project file was reported against a project that
  // has nothing to do with it, which is worse than the silence being replaced.
  const ours = new Set(realmDirNames.map((dir) => resolve(projectDir, dir)))

  const places: PlaceReport[] = []
  for (const file of files) {
    const mounted = await mountedInstalls(file)
    // One install is one tree, and everything wrong inside it is already `dedupe`'s
    // report. This check is only about what a second tree adds.
    if (mounted.size < 2) continue
    if (![...mounted.keys()].some((dir) => ours.has(dir))) continue

    const report = compare(mounted, root)
    if (report.length === 0) continue

    places.push({
      project: rel(root, file),
      installs: [...mounted.keys()].map((dir) => rel(root, dir)).sort(),
      duplicates: report,
    })
  }

  return { root, places }
}

/**
 * Where to start looking: the repository root, or the project itself.
 *
 * A monorepo member sits below the project file that mounts it, so searching only
 * downward from the member would never find the place it lands in — which is the whole
 * arrangement this check is about.
 *
 * **The repository is the only boundary the user actually drew**, so it is the only one
 * worth ascending to. An earlier version fell back to "one level up" when there was no
 * repository, which reads a directory nobody said was related: for a project sitting in
 * a shared folder that means scanning every unrelated sibling, and it took five seconds
 * to do it. Without a repository root the search stays where it was started.
 */
async function searchRoot(projectDir: string): Promise<string> {
  let dir = resolve(projectDir)

  for (let i = 0; i < MAX_ASCENT; i++) {
    if (await exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return resolve(projectDir)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Install directories a project file mounts, and what each holds.
 *
 * Every `$path` is followed, not only the ones named like a realm directory: from a
 * sibling project's point of view this project's `Packages` is just some folder, and
 * the check would see nothing if it insisted on the name it expected.
 */
async function mountedInstalls(file: string): Promise<Map<string, Map<string, string>>> {
  const found = new Map<string, Map<string, string>>()

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // Unreadable or malformed is `place.ts`'s note to make, not a second one here.
    return found
  }

  const tree = asNode(asNode(parsed)?.tree)
  if (tree === undefined) return found

  const base = dirname(file)
  const seen = new Set<string>()

  const visit = async (node: Readonly<Record<string, unknown>>): Promise<void> => {
    const declared = pathOf(node.$path)
    if (declared !== undefined) {
      const dir = resolve(base, declared)
      if (!seen.has(dir)) {
        seen.add(dir)
        const entries = await readIndex(dir)
        if (entries !== undefined) found.set(dir, entries)
      }
    }

    for (const key of Object.keys(node)) {
      if (key.startsWith('$')) continue
      const child = asNode(node[key])
      if (child !== undefined) await visit(child)
    }
  }

  await visit(tree)
  return found
}

/** Package name -> version, from `<dir>/_Index/{scope}_{name}@{version}`. */
async function readIndex(dir: string): Promise<Map<string, string> | undefined> {
  let entries: string[]
  try {
    entries = await readdir(join(dir, INDEX_DIR_NAME))
  } catch {
    return undefined
  }

  const held = new Map<string, string>()
  for (const entry of entries) {
    const at = entry.lastIndexOf('@')
    if (at <= 0) continue
    const version = entry.slice(at + 1)
    const underscore = entry.indexOf('_')
    if (underscore <= 0) continue

    const scope = entry.slice(0, underscore)
    const name = entry.slice(underscore + 1, at)
    if (name === '') continue

    // A tree may legitimately hold two majors of one package; the newest is enough to
    // decide whether a *second* tree disagrees, and reporting every pair of every
    // version across every tree would bury the one line that matters.
    const key = toRarnName({ scope, name })
    const existing = held.get(key)
    if (existing === undefined || isNewer(version, existing)) held.set(key, version)
  }

  return held
}

function isNewer(candidate: string, current: string): boolean {
  const a = semver.parse(candidate)
  const b = semver.parse(current)
  return a !== null && b !== null && a.compare(b) > 0
}

function compare(
  mounted: ReadonlyMap<string, ReadonlyMap<string, string>>,
  root: string,
): PlaceDuplicate[] {
  const byName = new Map<string, TreeVersion[]>()

  for (const [dir, held] of mounted) {
    for (const [name, version] of held) {
      const list = byName.get(name) ?? []
      list.push({ dir: rel(root, dir), version })
      byName.set(name, list)
    }
  }

  const duplicates: PlaceDuplicate[] = []
  for (const [name, versions] of byName) {
    const distinct = new Set(versions.map((v) => v.version))
    if (distinct.size < 2) continue

    duplicates.push({
      name,
      compatible: anyCompatiblePair([...distinct]),
      versions: [...versions].sort(byVersionDescending),
    })
  }

  return duplicates.sort(
    (a, b) => Number(b.compatible) - Number(a.compatible) || byCodeUnit(a.name, b.name),
  )
}

/** Newest first, falling back to text for a directory name that is not a version. */
function byVersionDescending(a: TreeVersion, b: TreeVersion): number {
  const left = semver.parse(a.version)
  const right = semver.parse(b.version)
  if (left === null || right === null) return byCodeUnit(a.version, b.version)
  return right.compare(left)
}

function anyCompatiblePair(versions: readonly string[]): boolean {
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      try {
        if (areCompatible(versions[i] as string, versions[j] as string)) return true
      } catch {
        // A directory name that is not a version tells us nothing either way.
      }
    }
  }
  return false
}

function rel(root: string, path: string): string {
  const out = relative(root, path).replaceAll('\\', '/')
  return out === '' ? '.' : out
}

function pathOf(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && 'optional' in value
        ? (value as { optional?: unknown }).optional
        : undefined

  if (typeof raw !== 'string' || raw === '') return undefined
  return raw
}

function asNode(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}
