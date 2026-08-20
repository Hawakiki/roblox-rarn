import chalk from 'chalk'
import { Code } from '../util/codes.ts'
import { ExitCode, RarnError, RegistryError } from '../util/errors.ts'
import { outputSettings } from './output.ts'

/**
 * Turns a thrown value into the text the user sees.
 *
 * Color is applied here and nowhere else: the layer modules build plain strings so
 * that their output can be asserted in tests without stripping escape codes.
 */
export function renderError(error: unknown): string {
  // Commander throws for --help and --version, which are successful exits.
  if (isCommanderExit(error)) return ''

  if (error instanceof RarnError) return renderRarnError(error)
  if (isConnectionFailure(error)) return renderOffline(error)

  return renderUnexpected(error)
}

/**
 * The exit code a failure should produce.
 *
 * Split so that a script can tell "your manifest is wrong, stop retrying" from
 * "the network flaked, try again" without parsing English.
 */
export function exitCodeFor(error: unknown): ExitCode {
  if (isCommanderExit(error)) return ExitCode.Ok
  if (error instanceof RegistryError || isConnectionFailure(error)) return ExitCode.RegistryError
  return ExitCode.UserError
}

function renderRarnError(error: RarnError): string {
  // The code leads the line so it is the first thing a reader can copy into a
  // search. Wording may change between releases; the code never does.
  const lines = [`${chalk.red(error.code)}: ${error.what}`]
  if (error.where !== undefined) lines.push(chalk.dim(`  at ${error.where}`))
  if (error.detail !== undefined) lines.push('', error.detail)
  if (error.how !== undefined) lines.push('', chalk.cyan(error.how))

  // The cause is what a bug report needs and what a normal run should never show.
  if (outputSettings().verbose && error.cause !== undefined) {
    lines.push('', chalk.dim(indent(stringify(error.cause))))
  }
  return lines.join('\n')
}

/**
 * DNS and connection failures, which are the common way this fails offline.
 *
 * Worth intercepting because Node's own wording (`getaddrinfo ENOTFOUND
 * api.wally.run`) reads as an internal fault. It is almost always just no network,
 * and the useful next step — reinstall from the lockfile, no network needed — is
 * not something the raw message would ever suggest.
 */
function renderOffline(error: unknown): string {
  return [
    `${chalk.red(Code.RegistryUnreachable)}: could not reach the registry.`,
    chalk.dim(`  ${messageOf(error)}`),
    '',
    chalk.cyan(
      'Check your connection. If rarn.lock is up to date, `rarn install` needs no network.',
    ),
  ].join('\n')
}

/**
 * The last resort: something escaped without being wrapped.
 *
 * Says so plainly rather than dressing it up as a user error. Every failure a user
 * can cause should already be a RarnError with a code and a `how`, so reaching here
 * is a gap in Rarn, and pretending otherwise sends the reader looking for a mistake
 * in their own project that they did not make.
 */
function renderUnexpected(error: unknown): string {
  const lines = [
    `${chalk.red(Code.InternalError)}: ${messageOf(error)}`,
    '',
    chalk.dim('This is a bug in Rarn — it should have been reported with an error code.'),
    chalk.dim('Please report it: https://github.com/Hawakiki/roblox-rarn/issues'),
  ]

  if (outputSettings().verbose && error instanceof Error && error.stack !== undefined) {
    lines.push('', chalk.dim(indent(error.stack)))
  } else {
    lines.push(chalk.dim('Run again with --verbose for a stack trace.'))
  }
  return lines.join('\n')
}

function isCommanderExit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const { code } = error
  return typeof code === 'string' && code.startsWith('commander.')
}

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isConnectionFailure(error: unknown): boolean {
  for (let cursor = error, hops = 0; cursor !== undefined && hops < 8; hops += 1) {
    if (typeof cursor === 'object' && cursor !== null && 'code' in cursor) {
      const { code } = cursor as { code?: unknown }
      if (typeof code === 'string' && OFFLINE_CODES.has(code)) return true
    }
    // fetch wraps the real failure one or two levels down, so the outer object
    // never carries the code that identifies it.
    cursor = cursor instanceof Error ? cursor.cause : undefined
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  return String(value)
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}
