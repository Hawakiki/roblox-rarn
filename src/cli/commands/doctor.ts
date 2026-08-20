import chalk from 'chalk'
import { runDoctor } from '../../doctor/check.ts'
import { loadInstalled, writeJson } from '../project.ts'

export interface DoctorOptions {
  cwd: string
  json?: boolean
}

/**
 * Reads the installed sources and reports where they disagree with the lockfile.
 *
 * Everything else Rarn checks is about versions and files. This is the one check
 * about *code*: whether each package actually requires what it said it would. A
 * mismatch produces `nil` at runtime with a perfectly healthy-looking install.
 */
export async function doctor(options: DoctorOptions): Promise<void> {
  const { projectDir, manifest, resolution } = await loadInstalled(options.cwd)
  const report = await runDoctor(projectDir, manifest, resolution)

  if (options.json === true) {
    writeJson(report)
    if (report.missingTotal > 0) process.exitCode = 1
    return
  }

  const lines: string[] = []

  for (const pkg of report.packages) {
    if (pkg.missing.length === 0 && pkg.unused.length === 0) continue
    if (lines.length > 0) lines.push('')
    lines.push(chalk.bold(pkg.key))

    for (const finding of pkg.missing) {
      lines.push(
        `  ${chalk.red('requires')} ${finding.alias} ${chalk.dim('— not a declared dependency')}`,
        chalk.dim(`    ${finding.file}:${finding.line}  resolves to nil at runtime`),
      )
    }
    for (const alias of pkg.unused) {
      lines.push(`  ${chalk.yellow('declares')} ${alias} ${chalk.dim('— never required')}`)
    }
  }

  if (lines.length === 0) {
    lines.push(chalk.green('no problems found'))
  }

  lines.push(
    '',
    chalk.dim(`  scanned ${report.filesScanned} files across ${resolution.packages.size} packages`),
  )

  // Stated plainly rather than left out. This check cannot see through a require
  // built at runtime, and a report that omits its own blind spot invites more trust
  // than it has earned.
  if (report.dynamicTotal > 0) {
    lines.push(
      chalk.dim(`  ${report.dynamicTotal} requires are built at runtime and could not be checked`),
    )
  }

  process.stdout.write(`${lines.join('\n')}\n`)

  // Only a missing dependency is a defect. An unused one costs a download, not
  // correctness, so it does not fail the command.
  if (report.missingTotal > 0) process.exitCode = 1
}
