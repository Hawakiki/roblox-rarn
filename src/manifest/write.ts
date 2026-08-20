import { writeFile } from 'node:fs/promises'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { parsePackageName, toRarnName } from '../util/package-name.ts'
import { manifestPath } from './read.ts'
import { DEPENDENCY_SECTIONS, type DependencySection, type Manifest } from './types.ts'

/**
 * Field order for a written manifest.
 *
 * A manifest is a file a person edits by hand, so a stable order matters: without
 * one, `rarn add` would shuffle unrelated lines and every diff would be noise.
 * Identity first, metadata second, dependencies last — the same shape as package.json.
 */
const FIELD_ORDER: readonly (keyof Manifest)[] = [
  '$schema',
  'name',
  'version',
  'description',
  'license',
  'authors',
  'homepage',
  'repository',
  'private',
  'realm',
  'registry',
  'packageDir',
  'place',
  'dependencies',
  'serverDependencies',
  'devDependencies',
  'resolutions',
  'aliases',
  'include',
  'exclude',
]

/** Serializes a manifest to the exact text that will be written. */
export function serializeManifest(manifest: Manifest): string {
  const ordered: Record<string, unknown> = {}

  for (const field of FIELD_ORDER) {
    const value = manifest[field]
    if (value === undefined) continue
    ordered[field] = isDependencySection(field) ? sortKeys(value as Record<string, string>) : value
  }

  // Any field the schema gained but this list has not caught up with is preserved
  // rather than dropped; losing a user's data over a stale constant is unacceptable.
  for (const [field, value] of Object.entries(manifest)) {
    if (!(field in ordered) && value !== undefined) ordered[field] = value
  }

  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Writes `rarn.json`, replacing whatever is there. */
export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const path = manifestPath(dir)
  try {
    await writeFile(path, serializeManifest(manifest), 'utf8')
  } catch (cause) {
    throw new RarnError({
      code: Code.ManifestUnreadable,
      what: 'Could not write rarn.json.',
      where: path,
      how: 'Check that the file is not read-only and the directory is writable.',
      cause,
    })
  }
}

function isDependencySection(field: keyof Manifest): field is DependencySection {
  return (DEPENDENCY_SECTIONS as readonly string[]).includes(field)
}

/** Dependencies sort by name so that `rarn add` produces a one-line diff. */
function sortKeys(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Returns a copy of `manifest` with one dependency added to `section`. */
export function withDependency(
  manifest: Manifest,
  section: DependencySection,
  name: string,
  range: string,
): Manifest {
  const key = toRarnName(parsePackageName(name))
  return {
    ...manifest,
    [section]: { ...manifest[section], [key]: range },
  }
}

/**
 * Returns a copy of `manifest` with a dependency removed from every section.
 *
 * Removal sweeps all three sections rather than requiring the caller to know which
 * one holds it, since `rarn remove @evaera/promise` should not need `--dev`.
 */
export function withoutDependency(
  manifest: Manifest,
  name: string,
): { manifest: Manifest; removedFrom: DependencySection[] } {
  const key = toRarnName(parsePackageName(name))
  const next: Manifest = { ...manifest }
  const removedFrom: DependencySection[] = []

  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest[section]
    if (deps === undefined || !(key in deps)) continue
    const { [key]: _removed, ...rest } = deps
    Object.assign(next, { [section]: rest })
    removedFrom.push(section)
  }

  return { manifest: next, removedFrom }
}
