import chalk from 'chalk'
import { RarnError } from '../util/errors.ts'

/**
 * Turns a thrown value into the text the user sees.
 *
 * Color is applied here and nowhere else: the layer modules build plain strings so
 * that their output can be asserted in tests without stripping escape codes.
 */
export function renderError(error: unknown): string {
  if (error instanceof RarnError) {
    const lines = [`${chalk.red('error')} ${error.what}`]
    if (error.where !== undefined) lines.push(chalk.dim(`  at ${error.where}`))
    if (error.detail !== undefined) lines.push('', error.detail)
    if (error.how !== undefined) lines.push('', chalk.cyan(error.how))
    return lines.join('\n')
  }

  // Commander throws for --help and --version, which are successful exits.
  if (isCommanderExit(error)) return ''

  const message = error instanceof Error ? error.message : String(error)
  return [
    `${chalk.red('error')} ${message}`,
    '',
    chalk.dim('This is a bug in Rarn — it should have been reported as a RarnError.'),
  ].join('\n')
}

function isCommanderExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('commander.')
  )
}
