import chalk from 'chalk'
import semver from 'semver'

import { type PlacesScan, scanPlaces } from '../../doctor/places.ts'
import { realmDirs } from '../../manifest/types.ts'
import { WarnCode } from '../../util/codes.ts'
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
  const { projectDir, manifest, resolution } = await loadInstalled(options.cwd)

  // Read before anything is printed, because it changes what the green line above it
  // is allowed to claim. "Every package is installed at exactly one version" is a
  // statement about this project; whether it is also true of the DataModel this
  // project ends up in is a different question, and one nothing else asks.
  const places = await scanPlaces(projectDir, Object.values(realmDirs(manifest.packageDir)))

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
    writeJson({ duplicates: report, places: places.places })
    return
  }

  if (report.length === 0) {
    process.stdout.write(
      [
        `${chalk.green('no duplicates')} — every package in this project is installed at exactly one version`,
        chalk.dim(
          '  Rarn resolves to the fewest versions possible, so there is nothing to dedupe.',
        ),
        ...crossTreeLines(places),
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
    ...crossTreeLines(places),
  )

  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * What a second install tree adds to the DataModel this one lands in.
 *
 * Printed by `dedupe` rather than by a command of its own because it answers the
 * question `dedupe` is already being asked, on the scope that actually decides the
 * answer. A duplicate here is invisible to every per-project check: each tree resolves
 * correctly, each lockfile holds one version, and Roblox still gets two ModuleScripts.
 */
export function crossTreeLines(scan: PlacesScan): string[] {
  if (scan.places.length === 0) return []

  const lines: string[] = ['']
  for (const place of scan.places) {
    const hazard = place.duplicates.some((d) => d.compatible)
    lines.push(
      `${hazard ? chalk.yellow(WarnCode.CrossTreeDuplicate) : chalk.dim(WarnCode.CrossTreeDuplicate)} ${place.project} builds one DataModel from ${place.installs.length} installs:`,
    )

    for (const duplicate of place.duplicates) {
      lines.push(`  ${chalk.bold(duplicate.name)}`)
      for (const version of duplicate.versions) {
        lines.push(`    ${version.version.padEnd(12)} ${chalk.dim('<-')} ${version.dir}`)
      }
      lines.push(
        duplicate.compatible
          ? chalk.dim(
              '    semver-compatible: two ModuleScript instances at runtime, each with its own state',
            )
          : chalk.dim('    different majors: two packages, which Roblox and Rarn both allow'),
      )
    }

    lines.push(
      '',
      chalk.dim('  Rarn resolves one project at a time, so no lockfile can see this.'),
      chalk.dim('  Converge the ranges, or mount the trees into different places.'),
    )
  }

  return lines
}
