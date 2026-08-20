import chalk from 'chalk'
import semver from 'semver'

import { loadInstalled, writeJson } from '../project.ts'

export interface DedupeOptions {
  cwd: string
  json?: boolean
}

/**
 * Reports packages installed at more than one version, and why.
 *
 * **This does not deduplicate.** Yarn's command of the same name re-resolves to
 * shrink the version count, which works because its resolver picks greedily and can
 * leave avoidable duplicates behind. Rarn's resolver collects every constraint before
 * choosing anything and takes the intersection, so its output is already minimal —
 * there is nothing left to squeeze. What remains is genuinely incompatible, and the
 * only lever is `resolutions`.
 *
 * So this command explains rather than fixes. In Roblox that explanation matters more
 * than it would elsewhere: two copies are two ModuleScript instances with separate
 * state, so any singleton inside the package quietly becomes two.
 */
export async function dedupe(options: DedupeOptions): Promise<void> {
  const { resolution } = await loadInstalled(options.cwd)

  const report = [...resolution.duplicates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, versions]) => ({
      name,
      versions: [...versions].sort(semver.rcompare),
      requesters: [...versions].sort(semver.rcompare).map((version) => ({
        version,
        wantedBy: (resolution.packages.get(`${name}@${version}`)?.requestedBy ?? []).map((c) => ({
          from: c.from,
          range: c.range,
        })),
      })),
    }))

  if (options.json === true) {
    writeJson({ duplicates: report })
    return
  }

  if (report.length === 0) {
    process.stdout.write(
      [
        `${chalk.green('no duplicates')} — every package is installed at exactly one version`,
        chalk.dim(
          '  Rarn resolves to the fewest versions possible, so there is nothing to dedupe.',
        ),
        '',
      ].join('\n'),
    )
    return
  }

  const lines: string[] = []
  for (const entry of report) {
    if (lines.length > 0) lines.push('')
    lines.push(`${chalk.yellow(entry.name)} is installed at ${entry.versions.length} versions:`)

    for (const group of entry.requesters) {
      lines.push(`  ${chalk.bold(group.version)}`)
      for (const requester of group.wantedBy) {
        const label = requester.from === 'root' ? 'rarn.json (direct dependency)' : requester.from
        lines.push(`    ${requester.range.padEnd(20)} ${chalk.dim('<-')} ${label}`)
      }
    }

    lines.push(
      '',
      chalk.dim('  Two copies are two ModuleScript instances at runtime, each with its own'),
      chalk.dim('  state, so any singleton inside this package stops being one.'),
      '',
      `  Force one version with:  ${chalk.cyan(`"resolutions": { ${JSON.stringify(entry.name)}: ${JSON.stringify(entry.versions[0] ?? '')} }`)}`,
    )
  }

  lines.push(
    '',
    chalk.dim('These could not be merged automatically — their ranges do not overlap.'),
    chalk.dim(`Run \`rarn why ${report[0]?.name ?? ''}\` for the full paths.`),
  )

  process.stdout.write(`${lines.join('\n')}\n`)
}
