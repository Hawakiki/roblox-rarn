import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type NormalizedManifest, type PlaceInfo, realmDirs } from '../manifest/types.ts'
import type { Placement } from '../resolver/types.ts'
import { isNotFoundError } from '../util/fs.ts'
import { PROJECT_FILE_NAME } from './rojo.ts'

/** Where each realm directory was found in a place project's tree. */
export type DirToPath = ReadonlyMap<string, string>

export interface PlaceScan {
  /** Realm directory (`Packages`) -> DataModel path (`game.ReplicatedStorage.Packages`). */
  readonly found: DirToPath
  /** Non-fatal observations. Never a reason to fail an install. */
  readonly notes: readonly string[]
  /** Whether a place project file was read at all. */
  readonly scanned: boolean
}

const EMPTY: PlaceScan = { found: new Map(), notes: [], scanned: false }

/**
 * Finds where a project's Rojo file puts each realm directory.
 *
 * `place` in `rarn.json` and the tree in `default.project.json` are the same fact
 * written twice, and only one of them is load-bearing at runtime. When they disagree
 * a cross-realm shim names a DataModel path that does not exist, and Roblox reports
 * that as `Requested module experienced an error while loading` — no path, no missing
 * name, nothing. Measured in Studio: the real cause sits one layer down, as a second
 * line in Output, and the install, the file tree and the require harness are all
 * correct right up until then.
 *
 * So this reads the fact that is actually true and lets the manifest be checked
 * against it.
 *
 * **Never throws.** A project file Rarn cannot interpret produces a note and no
 * mapping, exactly like `findModuleRoot` — refusing to install because a Rojo file
 * has a shape this does not model would be a worse outcome than not deriving.
 */
export async function scanPlaceProject(
  projectDir: string,
  manifest: NormalizedManifest,
): Promise<PlaceScan> {
  const path = join(projectDir, PROJECT_FILE_NAME)

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return EMPTY
    return { found: new Map(), notes: [`${PROJECT_FILE_NAME} is unreadable`], scanned: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { found: new Map(), notes: [`${PROJECT_FILE_NAME} is not valid JSON`], scanned: false }
  }

  const tree = asNode(parsed)?.tree
  const root = asNode(tree)
  if (root === undefined) {
    return { found: new Map(), notes: [`${PROJECT_FILE_NAME} has no "tree"`], scanned: false }
  }

  // A library's project file is `{ "tree": { "$path": "src" } }` with no services
  // under it — the shape `findModuleRoot` reads. It describes a module, not a place,
  // and walking it would produce nothing while implying something was checked.
  if (childKeys(root).length === 0) return EMPTY

  const wanted = new Set(Object.values(realmDirs(manifest.packageDir)))
  const found = new Map<string, string>()
  const notes: string[] = []

  walk(root, ['game'], wanted, found, notes)
  return { found, notes, scanned: true }
}

function walk(
  node: Readonly<Record<string, unknown>>,
  trail: readonly string[],
  wanted: ReadonlySet<string>,
  found: Map<string, string>,
  notes: string[],
): void {
  const target = pathOf(node.$path)

  if (target !== undefined && wanted.has(target) && trail.length > 1) {
    const dataModelPath = trail.join('.')
    const existing = found.get(target)
    if (existing === undefined) {
      found.set(target, dataModelPath)
    } else if (existing !== dataModelPath) {
      // Rojo allows the same folder to be mounted twice. Two DataModel paths for one
      // realm means two copies of every package in it at runtime — the duplication
      // this whole layout exists to prevent — so it is reported rather than resolved.
      notes.push(`${PROJECT_FILE_NAME} mounts ${target}/ at both ${existing} and ${dataModelPath}`)
    }
  }

  // A node can carry `$path` *and* children — `"Packages": { "$path": "src/packages",
  // "Roact": { ... } }` is a real project file — so descending is not conditional on
  // the node having been a leaf.
  for (const key of childKeys(node)) {
    const child = asNode(node[key])
    if (child !== undefined) walk(child, [...trail, key], wanted, found, notes)
  }
}

/**
 * Reads `$path`, which is not always a string.
 *
 * `{ "optional": "Packages" }` is Rojo's form for a path that may be absent, and a
 * project that installs packages is exactly the kind that uses it — the folder does
 * not exist until someone runs the package manager. Treating it as unreadable would
 * skip the mapping on the projects that need it most.
 */
function pathOf(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && 'optional' in value
        ? (value as { optional?: unknown }).optional
        : undefined

  if (typeof raw !== 'string' || raw === '') return undefined
  return raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

/** Child instance names: every key that is not a `$`-prefixed Rojo directive. */
function childKeys(node: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(node).filter((key) => !key.startsWith('$'))
}

function asNode(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

export interface ResolvedPlace {
  readonly place: PlaceInfo
  /** Lines worth printing. Disagreements first, then anything else observed. */
  readonly notes: readonly string[]
  /** Kept so the realms that actually received packages can be checked after linking. */
  readonly scan: PlaceScan
}

/**
 * Warns about a realm directory the install filled that the Rojo project ignores.
 *
 * This is the failure a Wally import walks straight into. Wally uses three
 * independent names — `Packages`, `ServerPackages`, `DevPackages` — while Rarn
 * derives its other two by suffix, so an imported project has `Packages` mounted and
 * nothing at `Packages_SERVER`. Rarn installs there, Rojo never syncs it, and the
 * server realm simply is not in the DataModel.
 *
 * Nothing else notices. The install succeeds, the file tree is right, the require
 * harness passes — and in Studio the packages are absent, which surfaces later and
 * somewhere else as `Requested module experienced an error while loading`.
 */
export function unmountedRealms(
  scan: PlaceScan,
  manifest: NormalizedManifest,
  used: readonly Placement[],
): string[] {
  if (!scan.scanned) return []

  const dirs = realmDirs(manifest.packageDir)
  const warnings: string[] = []

  for (const placement of used) {
    const dir = dirs[placement]
    if (scan.found.has(dir)) continue
    warnings.push(
      `${dir}/ has packages in it, but ${PROJECT_FILE_NAME} does not put it anywhere. Rojo will not sync it, so nothing in it reaches Studio.`,
    )
  }

  return warnings
}

/** The Rojo entry a project needs so that a realm directory reaches the DataModel. */
export function rojoSnippet(dir: string, service: string): string {
  return [`  "${service}": {`, `    "${dir}": { "$path": "${dir}" }`, '  }'].join('\n')
}

/**
 * The `place` to link with: what the manifest declares, filled in from the Rojo file.
 *
 * The manifest wins where it speaks. Someone who wrote a path down meant it, and a
 * derived value silently overriding it would make the declared field a lie — but the
 * disagreement is still worth saying out loud, because one of the two is wrong and
 * the runtime will not say which.
 */
export async function resolvePlace(
  projectDir: string,
  manifest: NormalizedManifest,
): Promise<ResolvedPlace> {
  const scan = await scanPlaceProject(projectDir, manifest)
  const dirs = realmDirs(manifest.packageDir)
  const notes = [...scan.notes]

  const pick = (placement: Exclude<Placement, 'dev'>, declared: string | undefined) => {
    const derived = scan.found.get(dirs[placement])
    if (declared !== undefined && derived !== undefined && declared !== derived) {
      notes.push(
        `place.${placement}Packages says ${declared}, but ${PROJECT_FILE_NAME} puts ${dirs[placement]}/ at ${derived}. Using the manifest.`,
      )
    }
    return declared ?? derived
  }

  const shared = pick('shared', manifest.place.sharedPackages)
  const server = pick('server', manifest.place.serverPackages)

  return {
    place: {
      ...(shared === undefined ? {} : { sharedPackages: shared }),
      ...(server === undefined ? {} : { serverPackages: server }),
    },
    notes,
    scan,
  }
}
