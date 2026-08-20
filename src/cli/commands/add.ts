import { resolve as resolvePath } from 'node:path'
import chalk from 'chalk'
import semver from 'semver'
import { readManifestRaw } from '../../manifest/read.ts'
import type { DependencySection } from '../../manifest/types.ts'
import { validateManifest } from '../../manifest/validate.ts'
import { withDependency, writeManifest } from '../../manifest/write.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toRarnName, toWallyName } from '../../util/package-name.ts'
import { normalizeRange } from '../../util/version-range.ts'
import { install } from './install.ts'

export interface AddOptions {
  cwd: string
  specs: readonly string[]
  dev?: boolean
  server?: boolean
  /** Write the exact version rather than a caret range, like `yarn add -E`. */
  exact?: boolean
}

/**
 * Adds packages to the manifest and installs.
 *
 * A spec without a range resolves to the newest published release. The registry has
 * no dist-tags — no `latest`, no `next` — so "newest" is something Rarn computes from
 * the version list rather than something the registry declares. Prereleases are
 * excluded unless one is named explicitly, since `promise` publishes `4.0.0` and
 * `4.0.0-rc.2` side by side with nothing to tell them apart.
 */
export async function add(
  options: AddOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const projectDir = resolvePath(options.cwd)
  const section = sectionFor(options)

  let manifest = await readManifestRaw(projectDir)
  const added: string[] = []

  for (const spec of options.specs) {
    const { name, range } = parseSpec(spec)
    const resolved = range ?? (await newestRange(registry, spec, name, options.exact === true))
    manifest = withDependency(manifest, section, toRarnName(name), resolved)
    added.push(`${toRarnName(name)}@${resolved}`)
  }

  // Validated before writing, so a bad addition fails the same way a hand-edited
  // manifest would rather than leaving a file that cannot be loaded.
  validateManifest(manifest, 'rarn.json')
  await writeManifest(projectDir, manifest)

  for (const entry of added) {
    process.stdout.write(`${chalk.green('added')} ${entry}${sectionLabel(section)}\n`)
  }

  await install({ cwd: projectDir }, registry)
}

function sectionFor(options: AddOptions): DependencySection {
  if (options.dev === true && options.server === true) {
    throw new RarnError({
      code: Code.InvalidArguments,
      what: 'A dependency cannot be both --dev and --server.',
      how: 'Pick one. --server means server-only at runtime; --dev means not shipped at all.',
    })
  }
  if (options.dev === true) return 'devDependencies'
  if (options.server === true) return 'serverDependencies'
  return 'dependencies'
}

function sectionLabel(section: DependencySection): string {
  if (section === 'devDependencies') return chalk.dim(' (dev)')
  if (section === 'serverDependencies') return chalk.dim(' (server)')
  return ''
}

/**
 * Splits `@scope/name` or `@scope/name@range`.
 *
 * The leading `@` makes the split awkward: the separator is the *last* `@`, and only
 * when it comes after the slash. `@evaera/promise` has an `@` that is part of the
 * name, not a range separator.
 */
function parseSpec(spec: string): { name: ReturnType<typeof parsePackageName>; range?: string } {
  const slash = spec.indexOf('/')
  const at = spec.lastIndexOf('@')

  if (slash !== -1 && at > slash) {
    return {
      name: parsePackageName(spec.slice(0, at)),
      range: normalizeRange(spec.slice(at + 1)),
    }
  }
  return { name: parsePackageName(spec) }
}

async function newestRange(
  registry: RegistryClient,
  spec: string,
  name: ReturnType<typeof parsePackageName>,
  exact: boolean,
): Promise<string> {
  const metadata = await registry.getMetadata(name)
  const stable = metadata.versions.filter((v) => semver.prerelease(v.version) === null)

  const chosen = stable[0] ?? metadata.versions[0]
  if (chosen === undefined) {
    throw new RarnError({
      code: Code.VersionNotFound,
      what: `${toWallyName(name)} has no published versions.`,
      where: spec,
      how: 'Check the package name, or pick a different package.',
    })
  }

  // Everything published is a prerelease. Refusing would make the package
  // uninstallable, so it is used — but the range names it exactly, because a caret
  // range would not match it on the next install.
  if (stable.length === 0) {
    process.stdout.write(
      `${chalk.yellow('warning')} ${toWallyName(name)} has only prereleases; using ${chosen.version}\n`,
    )
    return chosen.version
  }

  return exact ? chosen.version : `^${chosen.version}`
}
