import chalk from 'chalk'
import semver from 'semver'
import { createRegistryClient } from '../../registry/client.ts'
import type { PackageVersion, RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { writeJson } from '../project.ts'

export interface InfoOptions {
  cwd: string
  spec: string
  json?: boolean
}

/** Shows what the registry knows about a package. */
export async function info(
  options: InfoOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const { name, version } = parseSpec(options.spec)
  const metadata = await registry.getMetadata(name)

  const entry = selectVersion(metadata.versions, version)
  if (entry === undefined) {
    throw new RarnError({
      code: Code.VersionNotFound,
      what: `${toWallyName(name)} has no version ${version ?? '(any)'}.`,
      detail: `  published: ${metadata.versions.map((v) => v.version).join(', ')}`,
      how: 'Pick one of the versions listed above.',
    })
  }

  if (options.json === true) {
    writeJson({
      name: `@${toWallyName(name)}`,
      version: entry.version,
      realm: entry.realm,
      description: entry.description,
      license: entry.license,
      versions: metadata.versions.map((v) => v.version),
      dependencies: Object.fromEntries(
        [...entry.dependencies].map(([alias, req]) => [
          alias,
          `@${toWallyName(req.name)}@${req.range}`,
        ]),
      ),
      serverDependencies: Object.fromEntries(
        [...entry.serverDependencies].map(([alias, req]) => [
          alias,
          `@${toWallyName(req.name)}@${req.range}`,
        ]),
      ),
    })
    return
  }

  const lines: string[] = [`${chalk.bold(chalk.cyan(`@${toWallyName(name)}`))} ${entry.version}`]
  if (entry.description !== undefined) lines.push(`  ${entry.description}`)
  lines.push('')

  const facts: [string, string][] = [
    ['realm', entry.realm],
    ['license', entry.license ?? chalk.dim('none declared')],
  ]
  for (const [label, value] of facts) {
    lines.push(`  ${chalk.dim(label.padEnd(9))} ${value}`)
  }

  const deps = [...entry.dependencies, ...entry.serverDependencies]
  lines.push('', `  ${chalk.dim('dependencies')}`)
  if (deps.length === 0) {
    lines.push(`    ${chalk.dim('none')}`)
  } else {
    const width = Math.max(...deps.map(([alias]) => alias.length))
    for (const [alias, req] of deps.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    ${alias.padEnd(width)}  @${toWallyName(req.name)} ${chalk.dim(req.range)}`)
    }
  }

  // Newest first and truncated: a package with 29 releases would otherwise bury
  // everything above it, and the recent ones are what a reader is choosing between.
  const versions = metadata.versions.map((v) => v.version)
  const preview = versions.slice(0, 10)
  lines.push('', `  ${chalk.dim(`versions (${versions.length})`)}`)
  lines.push(`    ${preview.join(', ')}${versions.length > preview.length ? ', …' : ''}`)
  lines.push('', chalk.dim(`  rarn add @${toWallyName(name)}`))

  process.stdout.write(`${lines.join('\n')}\n`)
}

/** Newest stable by default; prereleases only when one is named. */
function selectVersion(
  versions: readonly PackageVersion[],
  wanted: string | undefined,
): PackageVersion | undefined {
  if (wanted !== undefined) return versions.find((v) => v.version === wanted)
  return versions.find((v) => semver.prerelease(v.version) === null) ?? versions[0]
}

function parseSpec(spec: string): { name: ReturnType<typeof parsePackageName>; version?: string } {
  const slash = spec.indexOf('/')
  const at = spec.lastIndexOf('@')
  if (slash !== -1 && at > slash) {
    return { name: parsePackageName(spec.slice(0, at)), version: spec.slice(at + 1) }
  }
  return { name: parsePackageName(spec) }
}
