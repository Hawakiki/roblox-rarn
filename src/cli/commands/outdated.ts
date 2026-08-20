import chalk from 'chalk'
import semver from 'semver'
import { DEPENDENCY_SECTIONS } from '../../manifest/types.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../../util/concurrency.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { normalizeRange } from '../../util/version-range.ts'
import { loadInstalled, writeJson } from '../project.ts'

export interface OutdatedOptions {
  cwd: string
  json?: boolean
  /** Exit non-zero when anything is out of date, for CI. */
  check?: boolean
}

interface Row {
  readonly name: string
  readonly current: string
  /** Newest release the declared range already allows — a plain `rarn up` gets this. */
  readonly wanted: string
  /** Newest release at all — reaching it may mean widening the range. */
  readonly latest: string
  readonly range: string
}

/**
 * Compares what is installed against what the registry now offers.
 *
 * Only direct dependencies. A transitive package's version is decided by its
 * parent's range, so there is nothing the reader could change about it here —
 * listing it would be noise that looks like a task.
 *
 * `wanted` and `latest` differ exactly when a newer major exists: `wanted` is what
 * upgrading gets you today, `latest` is what widening the range would.
 */
export async function outdated(
  options: OutdatedOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const { manifest, resolution } = await loadInstalled(options.cwd)

  const declared: { name: string; range: string }[] = []
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section])) {
      declared.push({ name, range })
    }
  }

  const rows = (
    await mapWithConcurrency(declared, DEFAULT_CONCURRENCY, async (entry) => {
      const name = parsePackageName(entry.name)
      const installed = [...resolution.packages.values()].find(
        (pkg) => toWallyName(pkg.name) === toWallyName(name),
      )
      if (installed === undefined) return undefined

      const metadata = await registry.getMetadata(name)
      const stable = metadata.versions
        .map((v) => v.version)
        .filter((v) => semver.prerelease(v) === null)

      const latest = stable[0]
      const wanted = stable.find((v) => semver.satisfies(v, normalizeRange(entry.range)))
      if (latest === undefined || wanted === undefined) return undefined

      if (wanted === installed.version && latest === installed.version) return undefined

      return {
        name: entry.name,
        current: installed.version,
        wanted,
        latest,
        range: entry.range,
      } satisfies Row
    })
  ).filter((row): row is Row => row !== undefined)

  rows.sort((a, b) => a.name.localeCompare(b.name))

  if (options.json === true) {
    writeJson(rows)
  } else if (rows.length === 0) {
    process.stdout.write(`${chalk.green('up to date')} — every direct dependency is current\n`)
  } else {
    process.stdout.write(render(rows))
  }

  // Opt-in rather than automatic. `outdated` is something people run casually, and a
  // command that fails merely for reporting news would be reached for less often.
  if (options.check === true && rows.length > 0) process.exitCode = 1
}

function render(rows: readonly Row[]): string {
  const columns: [string, (row: Row) => string][] = [
    ['package', (row) => row.name],
    ['current', (row) => row.current],
    ['wanted', (row) => row.wanted],
    ['latest', (row) => row.latest],
  ]

  const widths = columns.map(([header, get]) =>
    Math.max(header.length, ...rows.map((row) => get(row).length)),
  )

  const lines = [chalk.dim(columns.map(([header], i) => header.padEnd(widths[i] ?? 0)).join('  '))]

  for (const row of rows) {
    const cells = columns.map(([, get], i) => get(row).padEnd(widths[i] ?? 0))
    lines.push(
      [
        cells[0],
        chalk.dim(cells[1]),
        row.wanted === row.current ? chalk.dim(cells[2]) : chalk.green(cells[2] ?? ''),
        row.latest === row.wanted ? chalk.dim(cells[3]) : chalk.yellow(cells[3] ?? ''),
      ].join('  '),
    )
  }

  const behind = rows.filter((row) => row.wanted !== row.current)
  const majors = rows.filter((row) => row.latest !== row.wanted)

  lines.push('')
  if (behind.length > 0) lines.push(chalk.dim(`  \`rarn up\` moves ${behind.length} to wanted.`))
  if (majors.length > 0) {
    lines.push(
      chalk.dim(
        `  ${majors.length} have a newer release outside the declared range — \`rarn up --latest\` widens it.`,
      ),
    )
  }

  return `${lines.join('\n')}\n`
}
