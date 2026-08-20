import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isNotFoundError, pathExists } from '../util/fs.ts'

export const PROJECT_FILE_NAME = 'default.project.json'

/** How the module root was decided. */
export type ModuleRootSource =
  /** A `default.project.json` named it. */
  | 'project-file'
  /** No project file, so the archive root is the module. */
  | 'archive-root'
  /** A project file exists but could not be interpreted; the archive root is used. */
  | 'fallback'

export interface ModuleRoot {
  /** Path relative to the extracted directory. Empty string means the root itself. */
  readonly path: string
  /**
   * Whether the module is a directory or a single file.
   *
   * Both occur: `red-blox/signal` points `$path` at `Signal.luau`. Assuming a
   * directory produces an install where the package simply is not there.
   */
  readonly kind: 'directory' | 'file'
  readonly source: ModuleRootSource
  /** Why the fallback happened, when it did. Worth showing; never fatal. */
  readonly note: string | undefined
}

const ARCHIVE_ROOT: ModuleRoot = {
  path: '',
  kind: 'directory',
  source: 'archive-root',
  note: undefined,
}

/**
 * Works out which part of an extracted archive is the actual module.
 *
 * A Wally archive is the package's whole source repository, not its module tree:
 * `evaera/promise@4.0.0` ships 340 files while the module is one file at
 * `lib/init.lua`. The `default.project.json` at the archive root — a Rojo project
 * file — is what says which subpath is real.
 *
 * This matters for correctness, not just size. Copying the archive root puts the
 * module one level too deep, so `require(_Index[...].promise)` lands on a Folder
 * instead of a ModuleScript. Wally gets away with it because Rojo reinterprets the
 * nested project file at sync time — which is precisely why Wally installs need Rojo
 * and pruning at install time removes that requirement.
 *
 * **Never throws.** Anything unreadable falls back to the archive root with a note,
 * because a package that installs slightly bloated beats an install that fails.
 */
export async function findModuleRoot(extractedDir: string): Promise<ModuleRoot> {
  const projectPath = join(extractedDir, PROJECT_FILE_NAME)

  let text: string
  try {
    text = await readFile(projectPath, 'utf8')
  } catch (error) {
    // Absent is the *normal* case, not an error: half the sampled packages set
    // `include` when publishing, so their archive root already is the module.
    // Warning here would print a warning on half of all installs.
    if (isNotFoundError(error)) return ARCHIVE_ROOT
    return { ...ARCHIVE_ROOT, source: 'fallback', note: `${PROJECT_FILE_NAME} is unreadable` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...ARCHIVE_ROOT, source: 'fallback', note: `${PROJECT_FILE_NAME} is not valid JSON` }
  }

  const declared = readTreePath(parsed)
  if (declared.path === undefined) {
    return { ...ARCHIVE_ROOT, source: 'fallback', note: declared.why }
  }

  return await describeTarget(extractedDir, declared.path)
}

/**
 * Reads `tree.$path`, accepting only the shape every real package uses.
 *
 * Every package sampled from the registry writes exactly
 * `{ "name": ..., "tree": { "$path": "src" } }`. Richer project files can nest
 * nodes, set `$className`, or attach properties — all of which change what the tree
 * becomes in ways that only Rojo can carry out. Rather than half-interpret one and
 * install something subtly wrong, those are declined and the archive is copied whole,
 * which is exactly what Wally does for every package anyway.
 */
function readTreePath(parsed: unknown): { path?: string; why: string } {
  if (typeof parsed !== 'object' || parsed === null) {
    return { why: `${PROJECT_FILE_NAME} is not an object` }
  }

  const tree = (parsed as { tree?: unknown }).tree
  if (typeof tree !== 'object' || tree === null) {
    return { why: `${PROJECT_FILE_NAME} has no "tree"` }
  }

  const keys = Object.keys(tree)
  const extras = keys.filter((key) => key !== '$path')
  if (extras.length > 0) {
    return { why: `${PROJECT_FILE_NAME} uses ${extras.join(', ')}, which Rarn does not interpret` }
  }

  const path = (tree as { $path?: unknown }).$path
  if (typeof path !== 'string' || path === '') {
    return { why: `${PROJECT_FILE_NAME} has no usable "$path"` }
  }

  return { path, why: '' }
}

/** Validates the declared path and reports whether it is a file or a directory. */
async function describeTarget(extractedDir: string, declared: string): Promise<ModuleRoot> {
  const normalized = declared.replaceAll('\\', '/').replace(/^\.\//, '')

  // A project file is package-supplied data, so it gets the same escape check the
  // archive entries get. `$path: "../.."` would otherwise reach outside the cache.
  const target = resolve(extractedDir, normalized)
  const inside = relative(resolve(extractedDir), target)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return {
      ...ARCHIVE_ROOT,
      source: 'fallback',
      note: `${PROJECT_FILE_NAME} points outside the package ("${declared}")`,
    }
  }

  if (!(await pathExists(target))) {
    return {
      ...ARCHIVE_ROOT,
      source: 'fallback',
      note: `${PROJECT_FILE_NAME} points at "${declared}", which the archive does not contain`,
    }
  }

  const info = await stat(target)
  return {
    path: inside.replaceAll('\\', '/'),
    kind: info.isDirectory() ? 'directory' : 'file',
    source: 'project-file',
    note: undefined,
  }
}
