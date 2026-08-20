import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import { isInteractive, outputSettings } from './output.ts'

/**
 * A spinner for the stages of an install, or nothing at all.
 *
 * Two decisions worth keeping:
 *
 * **It writes to stderr.** Several commands emit JSON on stdout, and a spinner
 * repainting itself in the middle of that stream produces output no parser can
 * read. Progress is diagnostics, so it belongs on the diagnostic channel.
 *
 * **It disappears without a TTY.** Escape codes that redraw a line become hundreds
 * of junk lines in a CI log. Piped or redirected, this prints stage lines only when
 * `--verbose` asked for them, and the install summary carries the rest.
 */
export interface Progress {
  /** Begin a stage, replacing whatever stage was running. */
  stage(text: string): void
  /** Retitle the running stage — for counters that change many times a second. */
  update(text: string): void
  /** Stop without leaving a line behind. The summary that follows is the real output. */
  stop(): void
  /** Stop and leave a failure mark, so the error is not printed over a live spinner. */
  fail(): void
}

const NOOP: Progress = { stage: () => {}, update: () => {}, stop: () => {}, fail: () => {} }

export function createProgress(): Progress {
  const { silent, verbose } = outputSettings()
  if (silent) return NOOP

  const interactive = isInteractive(process.stderr)
  if (!interactive) return verbose ? plainProgress() : NOOP

  let spinner: Ora | undefined

  return {
    stage(text) {
      spinner?.stop()
      spinner = ora({ text, stream: process.stderr, spinner: 'dots' }).start()
    },
    update(text) {
      if (spinner !== undefined) spinner.text = text
    },
    stop() {
      spinner?.stop()
      spinner = undefined
    },
    fail() {
      spinner?.stopAndPersist({ symbol: chalk.red('✖') })
      spinner = undefined
    },
  }
}

/** Non-interactive `--verbose`: one line per stage, no redrawing. */
function plainProgress(): Progress {
  return {
    stage(text) {
      process.stderr.write(`${chalk.dim(`· ${text}`)}\n`)
    },
    // Deliberately dropped. Without a cursor to move, a counter that ticks once per
    // package would bury the log in lines nobody reads.
    update: () => {},
    stop: () => {},
    fail: () => {},
  }
}
