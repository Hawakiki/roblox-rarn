import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import { readManifestRaw } from '../../manifest/read.ts'
import { DEPENDENCY_SECTIONS, type DependencySection } from '../../manifest/types.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { withDependency, writeManifest } from '../../manifest/write.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { type RangeUpgrade, upgradeRanges } from '../../resolver/upgrade.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
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

  // One package in two sections is installed once, so its ranges are raised together.
  const upgrades = new Map<Declared, RangeUpgrade>()
  for (const entries of byPackage(targets)) {
    const metadata = await registry.getMetadata(parsePackageName(entries[0].name))
    const results = upgradeRanges(
      entries.map((entry) => entry.range),
      metadata.versions.map((v) => v.version),
      options.latest === true,
    )
    for (const [index, entry] of entries.entries()) {
      const result = results[index]
      if (result !== undefined) upgrades.set(entry, result)
    }
  }

  const changes: Change[] = []
  const kept: string[] = []
  for (const entry of targets) {
    const upgrade = upgrades.get(entry)
    if (upgrade === undefined) continue

    // Said out loud rather than skipped: the range is not rewritten, so the lockfile
    // stays fresh and, unless something else moves, the install below reuses it.
    if (upgrade.kind === 'kept') {
      kept.push(
        `${chalk.yellow('kept')} ${entry.name}  ${entry.range}  ${chalk.dim(`allows ${upgrade.newest}, but no exact rewrite raising only its floor was found. Left as written, so an older version may stay installed; edit the range to move it.`)}\n`,
      )
    }
    if (upgrade.kind !== 'raised') continue

    manifest = withDependency(manifest, entry.section, entry.name, upgrade.range)
    changes.push({
      name: entry.name,
      section: entry.section,
      before: entry.range,
      after: upgrade.range,
    })
  }

  if (changes.length === 0) {
    for (const line of kept) process.stdout.write(line)
    if (kept.length === 0) {
      process.stdout.write(`${chalk.dim('everything is already at the newest allowed version')}\n`)
    }
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
  for (const line of kept) process.stdout.write(line)

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

function byPackage(declared: readonly Declared[]): [Declared, ...Declared[]][] {
  const groups = new Map<string, [Declared, ...Declared[]]>()
  for (const entry of declared) {
    const key = toWallyName(parsePackageName(entry.name))
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [entry])
    else group.push(entry)
  }
  return [...groups.values()]
}
