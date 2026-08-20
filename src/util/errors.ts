import type { Code } from './codes.ts'

/**
 * The optional fields are written `?: T | undefined` on purpose. Under
 * `exactOptionalPropertyTypes` a bare `?: T` rejects an explicitly-passed
 * `undefined`, which would force every conditional field at a call site into a
 * spread just to satisfy the compiler. For an options bag, "absent" and
 * "explicitly undefined" should mean the same thing.
 */
export interface RarnErrorInit {
  /** Stable identifier from `Code`. Required — an uncoded error is unsearchable. */
  code: Code
  /** What went wrong, as one sentence. */
  what: string
  /** Where it went wrong: a file path, a package id, a URL. */
  where?: string | undefined
  /** What the user should do next. */
  how?: string | undefined
  /** Extra lines rendered verbatim under the message, e.g. a conflict table. */
  detail?: string | undefined
  cause?: unknown
}

/**
 * Every user-facing failure goes through `RarnError`.
 *
 * The fields exist so messages stay in the shape a person can act on: which error
 * this is, what broke, where, and what to do next. A message without `how` is
 * usually a message that leaves the user stuck.
 */
export class RarnError extends Error {
  readonly code: Code
  readonly what: string
  readonly where: string | undefined
  readonly how: string | undefined
  readonly detail: string | undefined

  constructor(init: RarnErrorInit) {
    super(init.what, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'RarnError'
    this.code = init.code
    this.what = init.what
    this.where = init.where
    this.how = init.how
    this.detail = init.detail
  }

  /** Plain-text rendering. The CLI layer adds color; the logic layer never does. */
  format(): string {
    const lines = [`${this.code}: ${this.what}`]
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
  constructor(init: RarnErrorInit) {
    super(init)
    this.name = 'RegistryError'
  }
}
