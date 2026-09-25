import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { type NormalizedManifest, type PlaceInfo, realmDirs } from '../manifest/types.ts'
import type { Placement } from '../resolver/types.ts'
import { isNotFoundError } from '../util/fs.ts'
import { byCodeUnit } from '../util/order.ts'
import { PROJECT_FILE_NAME } from './rojo.ts'

/** Where each realm directory was found in a place project's tree. */
export type DirToPath = ReadonlyMap<string, string>

export interface PlaceScan {
  /** Realm directory (`Packages`) -> DataModel path (`game.ReplicatedStorage.Packages`). */
  readonly found: DirToPath
  /**
   * Realm directories two project files put in different places.
   *
   * Separate from `found` because the two states need opposite treatment: an absent
   * mapping means nothing mounts the directory and should be warned about, while a
   * disputed one means something does and Rarn cannot tell which. The dispute is
   * already a note, so warning again would say the opposite of what is true.
   */
  readonly disputed: ReadonlySet<string>
  /** Non-fatal observations. Never a reason to fail an install. */
  readonly notes: readonly string[]
  /** Whether any project file was read and interpreted. */
  readonly scanned: boolean
}

const EMPTY: PlaceScan = { found: new Map(), disputed: new Set(), notes: [], scanned: false }

/** Rojo's convention: any `*.project.json`, of which `default` is only the common name. */
const PROJECT_FILE_SUFFIX = '.project.json'

/**
 * How far below the project root to look for project files.
 *
 * `places/lobby/default.project.json` is the shape a multi-place repo actually uses,
 * which is two levels down; three leaves room for one more without turning this into
 * a full-tree walk of somebody's game.
 */
const MAX_DEPTH = 3

/**
 * Finds where a project's Rojo files put each realm directory.
 *
 * `place` in `rarn.json` and the tree in a Rojo project file are the same fact
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
 * **Every `*.project.json` counts, not just the root `default` one.** Reading one
 * fixed filename was wrong in the case it mattered most: of the multi-place
 * repositories surveyed for R2, 25 of 30 have no `default.project.json` at the root —
 * they name their files per place (`client.project.json`) or nest them
 * (`places/lobby/default.project.json`). Those are exactly the projects that need a
 * derived `place`, and they were the ones getting nothing.
 *
 * **Never throws.** A project file Rarn cannot interpret produces a note and no
 * mapping, exactly like `findModuleRoot` — refusing to install because a Rojo file
 * has a shape this does not model would be a worse outcome than not deriving.
 */
export async function scanPlaceProject(
  projectDir: string,
  manifest: NormalizedManifest,
): Promise<PlaceScan> {
  const dirs = realmDirs(manifest.packageDir)
  const files = await findProjectFiles(projectDir, new Set(Object.values(dirs)))
  if (files.length === 0) return EMPTY

  const wanted = new Set(Object.values(dirs))
  const found = new Map<string, string>()
  /** First file to mount each realm, kept so a later disagreement can name both. */
  const claimedBy = new Map<string, { label: string; path: string }>()
  const disputed = new Set<string>()
  const notes: string[] = []
  let scanned = false

  for (const file of files) {
    const label = relative(projectDir, file).replaceAll('\\', '/')

    const root = await readTree(file, label, notes)
    if (root === undefined) continue

    // Reading it is what `scanned` records, not finding something in it. A library's
    // project file is `{ "tree": { "$path": "src" } }`, and walking it finds nothing
    // because there is nothing to find — but the realm directories really are outside
    // the tree it describes, which is the very thing `unmountedRealms` exists to say.
    // Short-circuiting here used to skip the warning too, so the failure was silent in
    // the shape every publishable package uses.
    scanned = true
    if (childKeys(root).length === 0) continue

    const perFile = new Map<string, string>()
    walk(root, ['game'], { base: dirname(file), projectDir, wanted }, perFile, label, notes)

    for (const [dir, path] of perFile) {
      const owner = claimedBy.get(dir)
      if (owner === undefined) {
        found.set(dir, path)
        claimedBy.set(dir, { label, path })
        continue
      }
      if (owner.path === path) continue

      // Two project files are two DataModels, and the same realm landing at different
      // paths in each means no single absolute path is right for both. Guessing one
      // produces the opaque Studio failure above, so nothing is derived and the reader
      // is told to declare `place` — which is the actionable half of the same problem.
      // Measured: 12 of 12 multi-place repositories mount at identical paths, so this
      // is the rare branch, not the common one.
      if (!disputed.has(dir)) {
        notes.push(
          `${owner.label} puts ${dir}/ at ${owner.path}, but ${label} puts it at ${path}. Not deriving "place" from either.`,
        )
      }
      disputed.add(dir)
      found.delete(dir)
    }
  }

  return { found, disputed, notes, scanned }
}

async function readTree(
  file: string,
  label: string,
  notes: string[],
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    notes.push(`${label} is unreadable`)
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    notes.push(`${label} is not valid JSON`)
    return undefined
  }

  const root = asNode(asNode(parsed)?.tree)
  if (root === undefined) {
    notes.push(`${label} has no "tree"`)
    return undefined
  }
  return root
}

/**
 * Every `*.project.json` at or below the project root, shallowest first.
 *
 * `_Index` is skipped because a package install holds one project file per package —
 * hundreds of library-form files describing somebody else's module, none of which say
 * anything about this project's places.
 */
export async function findProjectFiles(
  root: string,
  skip: ReadonlySet<string>,
  maxDepth = MAX_DEPTH,
): Promise<string[]> {
  const files: string[] = []

  async function visit(dir: string, depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile()) {
        if (entry.name.endsWith(PROJECT_FILE_SUFFIX)) files.push(path)
        continue
      }
      if (!entry.isDirectory()) continue
      if (depth + 1 > maxDepth) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.name === INDEX_DIR_NAME) continue
      // A realm directory holds installed packages, never this project's own places.
      if (skip.has(entry.name)) continue
      await visit(path, depth + 1)
    }
  }

  await visit(root, 0)

  // `default.project.json` at the root first, then shallowest, then by path, so the
  // file a reader would name themselves is the one that claims a realm first and the
  // notes come out in the same order on every machine. The path compared is the one the
  // notes print: by code unit `\` sorts after the digits and `/` before them, so the
  // OS's own spelling would put `lobby2` ahead of `lobby` on Windows alone.
  return files.sort(
    (a, b) => rank(root, a) - rank(root, b) || byCodeUnit(slashed(root, a), slashed(root, b)),
  )
}

/** Sort key: the root default file, then depth. */
function rank(root: string, file: string): number {
  const rel = slashed(root, file)
  if (rel === PROJECT_FILE_NAME) return -1
  return rel.split('/').length
}

function slashed(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}

/** `_Index`, spelled here to avoid the linker depending on this module or vice versa. */
export const INDEX_DIR_NAME = '_Index'

interface WalkContext {
  /** Directory the project file sits in; `$path` is relative to this, not the root. */
  readonly base: string
  readonly projectDir: string
  readonly wanted: ReadonlySet<string>
}

function walk(
  node: Readonly<Record<string, unknown>>,
  trail: readonly string[],
  context: WalkContext,
  found: Map<string, string>,
  label: string,
  notes: string[],
): void {
  const target = realmOf(node.$path, context)

  if (target !== undefined && trail.length > 1) {
    const dataModelPath = trail.join('.')
    const existing = found.get(target)
    if (existing === undefined) {
      found.set(target, dataModelPath)
    } else if (existing !== dataModelPath) {
      // Rojo allows the same folder to be mounted twice. Two DataModel paths for one
      // realm means two copies of every package in it at runtime — the duplication
      // this whole layout exists to prevent — so it is reported rather than resolved.
      notes.push(`${label} mounts ${target}/ at both ${existing} and ${dataModelPath}`)
    }
  }

  // A node can carry `$path` *and* children — `"Packages": { "$path": "src/packages",
  // "Roact": { ... } }` is a real project file — so descending is not conditional on
  // the node having been a leaf.
  for (const key of childKeys(node)) {
    const child = asNode(node[key])
    if (child !== undefined) walk(child, [...trail, key], context, found, label, notes)
  }
}

/**
 * The realm directory a `$path` names, or undefined if it names something else.
 *
 * Resolved against the project file's own directory rather than the project root,
 * because a nested place file reaches a root-level realm as `../../Packages`. Reading
 * the string literally worked only for a file sitting at the root, which is precisely
 * the arrangement the surveyed multi-place repositories do not use.
 */
function realmOf(value: unknown, context: WalkContext): string | undefined {
  const declared = pathOf(value)
  if (declared === undefined) return undefined

  const rel = relative(context.projectDir, resolvePath(context.base, declared)).replaceAll(
    '\\',
    '/',
  )
  return context.wanted.has(rel) ? rel : undefined
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
 * Warns about a realm directory the install filled that no Rojo project mounts.
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
 *
 * Silence still means "no project file at all". A project that describes no tree has
 * no place for the warning to be about, and inventing one would fire on every
 * repository that syncs by some other means.
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
    if (scan.found.has(dir) || scan.disputed.has(dir)) continue
    warnings.push(
      `${dir}/ has packages in it, but no Rojo project file puts it anywhere. Rojo will not sync it, so nothing in it reaches Studio.`,
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
        `place.${placement}Packages says ${declared}, but a Rojo project file puts ${dirs[placement]}/ at ${derived}. Using the manifest.`,
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
