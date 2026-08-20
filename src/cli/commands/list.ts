import chalk from 'chalk'
import { DEPENDENCY_SECTIONS } from '../../manifest/types.ts'
import type { ResolvedPackage } from '../../resolver/types.ts'
import { parsePackageName, toWallyName } from '../../util/package-name.ts'
import { branch, loadInstalled, writeJson } from '../project.ts'

export interface ListOptions {
  cwd: string
  depth?: number
  json?: boolean
}

/**
 * Prints the installed tree, read entirely from the lockfile.
 *
 * No network and no resolution: this reports what *is* installed, not what a fresh
 * resolve would produce. If those two ever disagree, `rarn install` is the command
 * that says so — this one would only hide it.
 */
export async function list(options: ListOptions): Promise<void> {
  const { manifest, resolution } = await loadInstalled(options.cwd)
  const maxDepth = options.depth ?? Number.POSITIVE_INFINITY

  const roots: { alias: string; key: string }[] = []
  for (const section of DEPENDENCY_SECTIONS) {
    for (const rarnName of Object.keys(manifest[section]).sort()) {
      const key = findKey(resolution.packages, rarnName)
      if (key !== undefined) roots.push({ alias: rarnName, key })
    }
  }

  if (options.json === true) {
    writeJson({
      root: roots.map((r) => r.key),
      packages: Object.fromEntries(
        [...resolution.packages].map(([key, pkg]) => [
          key,
          {
            version: pkg.version,
            placement: pkg.placement,
            dev: pkg.dev,
            dependencies: Object.fromEntries(pkg.dependencies),
          },
        ]),
      ),
      duplicates: Object.fromEntries(resolution.duplicates),
    })
    return
  }

  if (roots.length === 0) {
    process.stdout.write(`${chalk.dim('no dependencies')}\n`)
    return
  }

  const lines: string[] = [chalk.bold(manifest.name)]
  // Shared across the whole print, not per-branch: a package reached twice is the
  // *same instance* at runtime, and expanding it twice would suggest otherwise.
  const seen = new Set<string>()

  roots.forEach(({ key }, index) => {
    lines.push(
      ...render(key, resolution.packages, seen, '', index === roots.length - 1, 1, maxDepth),
    )
  })

  for (const [name, versions] of resolution.duplicates) {
    lines.push(
      '',
      `${chalk.yellow('duplicate')} ${name} at ${versions.join(' and ')} ${chalk.dim('— run `rarn why` to see who asked')}`,
    )
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

function render(
  key: string,
  packages: ReadonlyMap<string, ResolvedPackage>,
  seen: Set<string>,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number,
): string[] {
  const pkg = packages.get(key)
  if (pkg === undefined) return []

  const { head, body } = branch(isLast)
  const repeated = seen.has(key)
  const label = `${chalk.cyan(`@${toWallyName(pkg.name)}`)} ${pkg.version}`
  const tag = pkg.placement === 'shared' ? '' : chalk.dim(` (${pkg.placement})`)

  const lines = [`${prefix}${head}${label}${tag}${repeated ? chalk.dim(' ·') : ''}`]

  // A repeat is marked and not expanded. Beyond correctness this is what stops a
  // cyclic graph — legal in Luau — from printing forever.
  if (repeated || depth >= maxDepth) return lines
  seen.add(key)

  const deps = [...pkg.dependencies.values()].sort()
  deps.forEach((depKey, index) => {
    lines.push(
      ...render(
        depKey,
        packages,
        seen,
        prefix + body,
        index === deps.length - 1,
        depth + 1,
        maxDepth,
      ),
    )
  })

  return lines
}

function findKey(
  packages: ReadonlyMap<string, ResolvedPackage>,
  rarnName: string,
): string | undefined {
  const wally = toWallyName(parsePackageName(rarnName))
  for (const [key, pkg] of packages) {
    if (toWallyName(pkg.name) === wally) return key
  }
  return undefined
}
