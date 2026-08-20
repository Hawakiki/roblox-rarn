import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import semver from 'semver'
import { readManifestRaw } from '../../manifest/read.ts'
import { DEPENDENCY_SECTIONS, type DependencySection } from '../../manifest/types.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { withDependency, writeManifest } from '../../manifest/write.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { normalizeRange } from '../../util/version-range.ts'
import { install } from './install.ts'

export interface UpOptions {
  cwd: string
  /** Empty means every direct dependency. */
  specs: readonly string[]
  /** Ignore the declared range and take the newest published release. */
  latest?: boolean
}

interface Change {
  readonly name: string
  readonly section: DependencySection
  readonly before: string
  readonly after: string
}

/**
 * Raises the ranges in `rarn.json`, then reinstalls.
 *
 * This is the difference between `up` and `install`: `install` honours whatever the
 * manifest says and never edits it, while `up` **rewrites the range** so the newer
 * version is what the project asks for from now on. Without that, upgrading would
 * last exactly until the next resolution.
 *
 * Only direct dependencies are touched. A transitive package moves on its own once
 * its parent's range allows it, and rewriting a range the project does not declare
 * would be editing someone else's manifest.
 */
export async function up(
  options: UpOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  let manifest = await readManifestRaw(projectDir)

  const wanted = new Set(options.specs.map((spec) => toWallyName(parsePackageName(spec))))
  const declared = collectDeclared(manifest)

  for (const name of wanted) {
    if (!declared.some((entry) => toWallyName(parsePackageName(entry.name)) === name)) {
      throw new RarnError({
        code: Code.InvalidArguments,
        what: `@${name} is not a direct dependency of this project.`,
        where: 'rarn.json',
        how: '`rarn up` raises the ranges in rarn.json, so it only applies to what the manifest declares. Run `rarn list` to see the full tree.',
      })
    }
  }

  const targets = declared.filter(
    (entry) => wanted.size === 0 || wanted.has(toWallyName(parsePackageName(entry.name))),
  )

  const changes: Change[] = []
  for (const entry of targets) {
    const next = await nextRange(registry, entry, options.latest === true)
    if (next === undefined || next === entry.range) continue

    manifest = withDependency(manifest, entry.section, entry.name, next)
    changes.push({ name: entry.name, section: entry.section, before: entry.range, after: next })
  }

  if (changes.length === 0) {
    process.stdout.write(`${chalk.dim('everything is already at the newest allowed version')}\n`)
    await install({ cwd: projectDir }, registry)
    return
  }

  validateManifest(manifest, 'rarn.json')
  await writeManifest(projectDir, manifest)

  const width = Math.max(...changes.map((c) => c.name.length))
  for (const change of changes) {
    process.stdout.write(
      `${chalk.green('up')} ${change.name.padEnd(width)}  ${chalk.dim(change.before)} -> ${change.after}\n`,
    )
  }

  await install({ cwd: projectDir }, registry)
}

interface Declared {
  readonly name: string
  readonly section: DependencySection
  readonly range: string
}

function collectDeclared(manifest: Awaited<ReturnType<typeof readManifestRaw>>): Declared[] {
  const out: Declared[] = []
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      out.push({ name, section, range })
    }
  }
  return out
}

/**
 * The range this dependency should carry after upgrading, or undefined to leave it.
 *
 * Without `--latest` the newest version *the declared range already allows* is
 * chosen, and the range is rewritten to a caret on it. That looks like a no-op, and
 * usually is — the point is that `^1.2.0` becomes `^1.9.0`, which records that the
 * project has moved on and stops a later install from quietly resolving lower.
 */
async function nextRange(
  registry: RegistryClient,
  entry: Declared,
  latest: boolean,
): Promise<string | undefined> {
  const metadata = await registry.getMetadata(parsePackageName(entry.name))
  const stable = metadata.versions
    .map((v) => v.version)
    .filter((v) => semver.prerelease(v) === null)

  const candidates = latest
    ? stable
    : stable.filter((v) => semver.satisfies(v, normalizeRange(entry.range)))

  const best = candidates[0]
  if (best === undefined) return undefined

  const next = `^${best}`
  // Leave an exact pin alone unless --latest: someone who wrote `1.2.3` chose to
  // freeze it, and silently widening that to a caret would undo the decision.
  if (!latest && semver.valid(entry.range) !== null) return undefined
  return next
}
