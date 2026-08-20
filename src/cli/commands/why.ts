import chalk from 'chalk'
import type { Resolution } from '../../resolver/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { branch, loadInstalled, writeJson } from '../project.ts'

export interface WhyOptions {
  cwd: string
  spec: string
  json?: boolean
}

interface Step {
  readonly key: string
  readonly range: string
}

/**
 * Explains why a package is installed, by walking back to the manifest.
 *
 * The lockfile's `requestedBy` is already the reverse edge set, so every path is
 * available without touching the registry. Showing the *whole path* rather than just
 * the direct requesters is the point: when a version is lower than expected, the
 * package to fix is usually several links up, and naming only the immediate parent
 * leaves the reader to guess the rest.
 */
export async function why(options: WhyOptions): Promise<void> {
  const { resolution } = await loadInstalled(options.cwd)
  const matches = findMatches(resolution, options.spec)

  if (matches.length === 0) {
    throw new RarnError({
      code: Code.PackageNotFound,
      what: `${options.spec} is not installed.`,
      how: 'Run `rarn list` to see what is. The name must include its scope, as in `@evaera/promise`.',
    })
  }

  const report = matches.map((key) => ({ key, paths: pathsToRoot(resolution, key) }))

  if (options.json === true) {
    writeJson(report)
    return
  }

  const lines: string[] = []
  for (const { key, paths } of report) {
    if (lines.length > 0) lines.push('')
    lines.push(chalk.bold(key))

    if (paths.length === 0) {
      lines.push(chalk.dim('  nothing requests it — it may be left over from an edit'))
      continue
    }

    for (const path of paths) {
      lines.push('')
      lines.push(`  ${chalk.dim('rarn.json')}`)
      // A path is a chain, so every step is the only child of the one above it and
      // always draws the last-child elbow. Using the branching form here would draw
      // siblings that do not exist.
      path.forEach((step, index) => {
        const indent = ' '.repeat(index * 3)
        lines.push(`  ${indent}${branch(true).head}${step.key} ${chalk.dim(step.range)}`)
      })
    }
  }

  const duplicates = matches.length > 1
  if (duplicates) {
    lines.push(
      '',
      chalk.yellow('These are separate modules at runtime.'),
      chalk.dim(
        `  Pin one with "resolutions": { "@${toWallyName(parsePackageName(stripVersion(options.spec)))}": "x.y.z" }`,
      ),
    )
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Every distinct path from the manifest down to this package, nearest first.
 *
 * Depth-first from the target upward, carrying the visited set along the branch. A
 * dependency cycle is legal in Luau, so the guard is not optional — without it this
 * walks forever on a graph that installs perfectly well.
 */
function pathsToRoot(resolution: Resolution, target: string): Step[][] {
  const paths: Step[][] = []

  const walk = (key: string, tail: Step[], visited: Set<string>): void => {
    const pkg = resolution.packages.get(key)
    if (pkg === undefined) return

    for (const constraint of pkg.requestedBy) {
      const step: Step = { key, range: constraint.range }

      if (constraint.from === 'root') {
        paths.push([step, ...tail])
        continue
      }
      if (visited.has(constraint.from)) continue

      walk(constraint.from, [step, ...tail], new Set([...visited, constraint.from]))
    }
  }

  walk(target, [], new Set([target]))

  // Shortest first: the most direct explanation is usually the useful one.
  return paths.sort((a, b) => a.length - b.length)
}

/** Every installed version matching `@scope/name` or `@scope/name@version`. */
function findMatches(resolution: Resolution, spec: string): string[] {
  const wally = toWallyName(parsePackageName(stripVersion(spec)))
  const version = versionOf(spec)

  return [...resolution.packages.entries()]
    .filter(([, pkg]) => toWallyName(pkg.name) === wally)
    .filter(([, pkg]) => version === undefined || pkg.version === version)
    .map(([key]) => key)
    .sort()
}

function stripVersion(spec: string): string {
  const slash = spec.indexOf('/')
  const at = spec.lastIndexOf('@')
  return slash !== -1 && at > slash ? spec.slice(0, at) : spec
}

function versionOf(spec: string): string | undefined {
  const slash = spec.indexOf('/')
  const at = spec.lastIndexOf('@')
  return slash !== -1 && at > slash ? spec.slice(at + 1) : undefined
}
