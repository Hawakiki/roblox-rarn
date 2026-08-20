import chalk from 'chalk'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { toWallyName } from '../../util/package-name.ts'
import { writeJson } from '../project.ts'

export interface SearchOptions {
  cwd: string
  query: string
  json?: boolean
  limit?: number
}

/** Searches the registry. */
export async function search(
  options: SearchOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const results = await registry.search(options.query)
  const limit = options.limit ?? 25
  const shown = results.slice(0, limit)

  if (options.json === true) {
    writeJson(
      results.map((r) => ({
        name: `@${toWallyName(r.name)}`,
        versions: r.versions,
        description: r.description,
      })),
    )
    return
  }

  if (results.length === 0) {
    process.stdout.write(`${chalk.dim(`nothing matches ${JSON.stringify(options.query)}`)}\n`)
    return
  }

  const width = Math.max(...shown.map((r) => toWallyName(r.name).length + 1))
  const lines = shown.map((result) => {
    const name = chalk.cyan(`@${toWallyName(result.name)}`.padEnd(width))
    const version = (result.versions[0] ?? '').padEnd(10)
    const description = truncate(result.description ?? '', 60)
    return `  ${name}  ${chalk.dim(version)}  ${description}`
  })

  // Saying how many were hidden keeps a truncated list from reading as the whole
  // answer — the registry has thousands of packages and "no more results" is a
  // meaningfully different message from "here are the first 25".
  if (results.length > shown.length) {
    lines.push(
      chalk.dim(`  ... and ${results.length - shown.length} more (use --limit to see further)`),
    )
  }

  process.stdout.write(`${lines.join('\n')}\n\n${chalk.dim('rarn add @<scope>/<name>')}\n`)
}

function truncate(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
