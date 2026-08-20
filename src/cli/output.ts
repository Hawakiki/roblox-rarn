import chalk from 'chalk'

/**
 * The global output switches, in one place.
 *
 * These are process-wide because `--silent` and `--no-color` are process-wide facts:
 * threading them through every layer would put presentation concerns into modules
 * whose whole job is to stay free of them.
 */
export interface OutputSettings {
  readonly silent: boolean
  readonly verbose: boolean
}

let current: OutputSettings = { silent: false, verbose: false }

export function configureOutput(options: {
  silent?: boolean | undefined
  verbose?: boolean | undefined
  color?: boolean | undefined
}): void {
  current = {
    silent: options.silent === true,
    // --silent wins. Asking for both is contradictory, and the quieter reading is
    // the safe one: a script that passes --silent must not suddenly get output.
    verbose: options.verbose === true && options.silent !== true,
  }

  if (!shouldColor(options.color)) {
    chalk.level = 0
  } else if (chalk.level === 0) {
    // Only raised from off. A level chalk already worked out is left alone, so a
    // terminal that supports truecolor is not flattened to sixteen colors just
    // because this ran.
    chalk.level = 1
  }
}

/**
 * Whether to emit color.
 *
 * chalk already gets TTY detection right, including inside a `bun build --compile`
 * binary — verified, because it looked broken until the cause turned out to be a
 * `FORCE_COLOR=3` in the surrounding shell rather than anything Rarn or chalk did.
 *
 * What this changes is one precedence rule. chalk lets `FORCE_COLOR` win over
 * `NO_COLOR`; here `NO_COLOR` wins. It is the more specific request — a terminal
 * exports `FORCE_COLOR` once for everything it launches, while `NO_COLOR` is set by
 * someone who wants plain text from *this* run, and a preference that a general
 * setting can silently override is not much of a preference.
 */
function shouldColor(flag: boolean | undefined): boolean {
  if (flag === false) return false

  // https://no-color.org — set to any value at all, including the empty string.
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0'

  return isInteractive(process.stdout)
}

export function outputSettings(): OutputSettings {
  return current
}

/** Extra detail that is worth printing only when asked for. Goes to stderr. */
export function verbose(text: string): void {
  if (!current.verbose) return
  process.stderr.write(`${chalk.dim(`  ${text}`)}\n`)
}

/**
 * Whether a stream is attached to a terminal.
 *
 * Read through a hand-written type because Node's declares `isTTY` as `boolean`
 * while the runtime leaves it `undefined` on a pipe. Taking the declaration at face
 * value makes the undefined case unreachable to the type checker and the guard
 * against it look redundant, which is how a correct check gets deleted.
 */
export function isInteractive(stream: { isTTY?: boolean | undefined }): boolean {
  return stream.isTTY === true
}
