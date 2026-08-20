/**
 * Every user-facing failure goes through `RarnError`.
 *
 * The three fields exist so that messages stay in the shape a person can act on:
 * what broke, where it broke, and what to do next. A message missing `how` is
 * usually a message that leaves the user stuck.
 */
export class RarnError extends Error {
  /** What went wrong, as one sentence. */
  readonly what: string
  /** Where it went wrong: a file path, a package id, a URL. */
  readonly where: string | undefined
  /** What the user should do next. */
  readonly how: string | undefined
  /** Extra lines rendered verbatim under the message, e.g. a conflict table. */
  readonly detail: string | undefined

  constructor(opts: {
    what: string
    where?: string
    how?: string
    detail?: string
    cause?: unknown
  }) {
    super(opts.what, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'RarnError'
    this.what = opts.what
    this.where = opts.where
    this.how = opts.how
    this.detail = opts.detail
  }

  /** Plain-text rendering. The CLI layer adds color; the logic layer never does. */
  format(): string {
    const lines = [this.what]
    if (this.where !== undefined) lines.push(`  at ${this.where}`)
    if (this.detail !== undefined) lines.push('', this.detail)
    if (this.how !== undefined) lines.push('', this.how)
    return lines.join('\n')
  }
}

/** Exit codes. Kept distinct so scripts can tell a bad manifest from a flaky network. */
export const ExitCode = {
  Ok: 0,
  /** The user's project or arguments are wrong. Retrying will not help. */
  UserError: 1,
  /** The registry or network failed. Retrying might help. */
  RegistryError: 2,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/** Raised when the registry or the network is at fault rather than the user. */
export class RegistryError extends RarnError {
  constructor(opts: {
    what: string
    where?: string
    how?: string
    detail?: string
    cause?: unknown
  }) {
    super(opts)
    this.name = 'RegistryError'
  }
}
