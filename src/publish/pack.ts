import { readFile, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { zipSync } from 'fflate'
import type { NormalizedManifest } from '../manifest/types.ts'
import { realmDirs } from '../manifest/types.ts'
import { INDEX_DIR_NAME } from '../project/place.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { listFiles } from '../util/fs.ts'
import { renderWallyToml } from './wally-toml.ts'

/** The registry refuses anything larger. Measured against the live service. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024

/** The earliest instant a ZIP entry can record. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1)

export interface PackEntry {
  /** Path inside the archive, always with forward slashes. */
  readonly path: string
  readonly bytes: number
}

export interface PackResult {
  readonly archive: Uint8Array
  readonly entries: readonly PackEntry[]
  readonly totalBytes: number
}

/**
 * Builds the archive that gets uploaded.
 *
 * Always adds a generated `wally.toml`, because the registry reads the package name
 * and version out of that file rather than from anything Rarn sends alongside.
 */
export async function pack(projectDir: string, manifest: NormalizedManifest): Promise<PackResult> {
  requireScopedName(manifest)

  const files = await collect(projectDir, manifest)

  if (files.length === 0) {
    throw new RarnError({
      code: Code.PackEmpty,
      what: 'nothing would be published.',
      where: projectDir,
      how: 'Check the `include` and `exclude` lists in rarn.json.',
    })
  }

  const contents: Record<string, Uint8Array> = {}
  const entries: PackEntry[] = []

  for (const file of files) {
    const bytes = new Uint8Array(await readFile(join(projectDir, file)))
    contents[file] = bytes
    entries.push({ path: file, bytes: bytes.byteLength })
  }

  // Written last so a `wally.toml` already in the project cannot shadow the one
  // generated from rarn.json — the manifest of record is rarn.json, and letting a
  // stale hand-written copy win would publish a version nobody asked for.
  const generated = new TextEncoder().encode(renderWallyToml(manifest))
  contents['wally.toml'] = generated
  const withoutGenerated = entries.filter((e) => e.path !== 'wally.toml')
  const all = [...withoutGenerated, { path: 'wally.toml', bytes: generated.byteLength }].sort(
    (a, b) => a.path.localeCompare(b.path),
  )

  // A fixed timestamp and a fixed level, so the same input produces the same bytes
  // and `pack` twice in a row is verifiably one archive rather than two that merely
  // look alike. The date is the start of the ZIP epoch rather than 0 — the format
  // stores a DOS date and cannot represent anything before 1980, so 0 is not a
  // neutral value here but an unencodable one.
  const archive = zipSync(contents, { level: 9, mtime: ZIP_EPOCH })

  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new RarnError({
      code: Code.PackTooLarge,
      what: `the archive is ${kib(archive.byteLength)}, over the registry's ${kib(MAX_ARCHIVE_BYTES)} limit.`,
      detail: largest(all, 10),
      how: 'Add the biggest offenders to `exclude` in rarn.json, then run `rarn pack --list` to check.',
    })
  }

  return { archive, entries: all, totalBytes: archive.byteLength }
}

/**
 * Refuses a project whose name has no scope, before any work is done.
 *
 * A bare name is not a mistake — the schema allows it and `rarn init` writes one on
 * purpose, since a game is named after its folder and never published. But the
 * registry identifies every package as `@scope/name`, so the two facts collide the
 * first time someone packs a game.
 *
 * Without this the collision surfaces from `parsePackageName` deep inside
 * `renderWallyToml`, as `RN0020: Package name 'mygame' is missing its leading '@'`.
 * That message is written for a hand-edited manifest and reads as an accusation for
 * a name the user never typed — Rarn wrote it. Here the same situation says which
 * of the two things is true and what to change.
 */
function requireScopedName(manifest: NormalizedManifest): void {
  if (manifest.name.startsWith('@')) return

  throw new RarnError({
    code: Code.UnscopedPackage,
    what: `"${manifest.name}" has no scope, so there is nothing to publish it as.`,
    where: 'rarn.json',
    detail: [
      '  A bare name is fine for a game — `rarn init` writes one deliberately — but the',
      '  registry identifies packages as @scope/name, where the scope is a GitHub user or',
      '  organisation. Packing is the point where a project stops being only a game.',
    ].join('\n'),
    how: `Rename it to "@<your-github-name>/${manifest.name}" in rarn.json, or leave it as it is if this project is not meant to be published.`,
  })
}

/**
 * The file list, as archive-relative POSIX paths.
 *
 * `include` is a whitelist when present. Without one the whole project ships minus
 * the defaults below, which is the forgiving default — a missing file breaks the
 * package for everyone who installs it, while an extra one only wastes bytes.
 */
export async function collect(
  projectDir: string,
  manifest: NormalizedManifest,
): Promise<readonly string[]> {
  const found = (await listFiles(projectDir)).map((absolute) =>
    relative(projectDir, absolute).split(sep).join(posix.sep),
  )

  const include = manifest.include ?? []
  const defaults = alwaysExcluded(manifest)
  const installed = installedTreeRoots(found)
  const exclude = manifest.exclude ?? []

  // An exact path in `include` overrides the built-in exclusions; a glob does not.
  // Writing `.env` names one file and can only be deliberate, while `src/**` is a
  // statement about a directory — it should not quietly pull in a `src/.env` whose
  // existence the author never considered.
  const namedExactly = new Set(include.filter((p) => !p.includes('*') && !p.includes('?')))

  return (
    found
      .filter((path) => include.length === 0 || include.some((pattern) => matches(path, pattern)))
      .filter(
        (path) => namedExactly.has(path) || !defaults.some((pattern) => matches(path, pattern)),
      )
      .filter(
        (path) => namedExactly.has(path) || !installed.some((root) => path.startsWith(`${root}/`)),
      )
      // The author's own `exclude` is last and wins over everything, including their
      // own `include` — the narrower instruction is the more recent intent.
      .filter((path) => !exclude.some((pattern) => matches(path, pattern)))
      .sort()
  )
}

/**
 * What never belongs in a published package.
 *
 * Two different reasons, and the second one is the serious one.
 *
 * **Size.** The realm directories hold every dependency's full source, so shipping
 * them would put a second copy of half the registry inside the archive and blow the
 * 2 MiB limit on a package that is otherwise a few kilobytes.
 *
 * **Secrets.** A published version is permanent and public — the registry has no
 * unpublish — so a `.env` that goes up once is a credential leak that cannot be
 * taken back, only rotated. Excluding it by default is the only safe direction to
 * be wrong in: shipping one file too few breaks an install and gets fixed in
 * minutes, while shipping one file too many cannot be undone at all. Anyone who
 * genuinely means to publish a file named `.env` can name it in `include`.
 */
function alwaysExcluded(manifest: NormalizedManifest): string[] {
  const realms = realmDirs(manifest.packageDir)
  return [
    '.git/**',
    'node_modules/**',
    'dist/**',
    'rarn.lock',
    '*.rbxl',
    '*.rbxlx',
    '*.rbxl.lock',
    '.DS_Store',
    '**/.DS_Store',
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '*.pem',
    '*.key',
    '**/*.pem',
    '**/*.key',
    ...Object.values(realms).map((dir) => `${dir}/**`),
  ]
}

/**
 * Directories holding an installed dependency tree, found by shape rather than name.
 *
 * `alwaysExcluded` covers Rarn's own realm directories because it can derive them from
 * `packageDir`. It cannot know what another tool called *its*: Wally installs into
 * `Packages/`, `ServerPackages/` and `DevPackages/`, and a project that migrated still
 * has them sitting there. Measured while publishing the first real package — 339 of the
 * 388 files in that archive were a `DevPackages/` nobody meant to ship, and a published
 * version cannot be taken back.
 *
 * **Matching the names would be the obvious fix and the wrong one.** A project whose
 * *source* lives in `Packages/` would then publish nothing at all, and `include` cannot
 * rescue it because only an exactly-named path overrides a default exclusion — which is
 * impractical for a directory. `_Index` is the reserved name the layout is built on, and
 * it is what actually separates an install from a folder that happens to share a name.
 */
function installedTreeRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const path of paths) {
    const at = path.indexOf(`/${INDEX_DIR_NAME}/`)
    if (at > 0) roots.add(path.slice(0, at))
  }
  return [...roots]
}

/**
 * Glob matching, limited to what a manifest actually uses.
 *
 * `**` crosses directory separators, `*` and `?` do not. A bare directory name is
 * treated as that whole subtree, since `exclude: ["docs"]` obviously means the
 * folder and making the user write `docs/**` would be a trap rather than a rule.
 */
export function matches(path: string, pattern: string): boolean {
  if (pattern === path) return true

  const expanded = pattern.includes('*') || pattern.includes('?') ? pattern : `${pattern}/**`
  const source = expanded
    .split('**')
    .map((part) =>
      part
        .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]'),
    )
    .join('.*')

  return new RegExp(`^${source}$`).test(path)
}

function largest(entries: readonly PackEntry[], count: number): string {
  return [...entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count)
    .map((entry) => `  ${kib(entry.bytes).padStart(9)}  ${entry.path}`)
    .join('\n')
}

export function kib(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/** Present so a caller can report the uncompressed total beside the archive size. */
export async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size
}
