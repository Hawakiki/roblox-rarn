#!/usr/bin/env bun
import { Command } from 'commander'
import pkg from '../package.json' with { type: 'json' }
import { renderError } from './cli/render.ts'
import { Code } from './util/codes.ts'
import { ExitCode, RarnError, RegistryError } from './util/errors.ts'

/**
 * Command wiring only. Every command body delegates immediately — business logic
 * lives in the layer modules so it stays reachable from tests without a process.
 */
async function main(argv: readonly string[]): Promise<void> {
  const program = new Command()

  program
    .name('rarn')
    .description('A package manager for Roblox that speaks the Wally registry')
    .version(pkg.version, '-v, --version')
    .option('--cwd <path>', 'run as if started in this directory', process.cwd())
    .option('--verbose', 'show every step', false)
    .option('--silent', 'print only errors', false)
    .option('--no-color', 'disable colored output')

  program
    .command('init')
    .description('create a rarn.json in the current directory')
    .option('-y, --yes', 'accept the defaults without prompting', false)
    .action(notYetImplemented('init', 'M1'))

  program
    .command('add')
    .argument('<packages...>', 'packages to add, e.g. @evaera/promise or @evaera/promise@^4.0.0')
    .description('add packages to the manifest and install them')
    .option('-D, --dev', 'add as a development dependency', false)
    .option('--server', 'add as a server dependency', false)
    .action(notYetImplemented('add', 'M8'))

  program
    .command('install', { isDefault: true })
    .description('install everything the manifest asks for')
    .option('--frozen-lockfile', 'fail instead of updating a stale lockfile', false)
    .option('--production', 'skip development dependencies', false)
    .action(notYetImplemented('install', 'M8'))

  program
    .command('remove')
    .argument('<packages...>', 'packages to remove')
    .description('remove packages from the manifest and reinstall')
    .action(notYetImplemented('remove', 'M8'))

  program
    .command('up')
    .argument('[packages...]', 'packages to upgrade; all of them when omitted')
    .description('upgrade packages to the newest version their range allows')
    .option('--latest', 'ignore the declared range and take the newest release', false)
    .action(notYetImplemented('up', 'M8'))

  program
    .command('list')
    .alias('ls')
    .description('show the installed dependency tree')
    .option('--depth <n>', 'how deep to print', Number.parseInt)
    .option('--json', 'emit machine-readable output', false)
    .action(notYetImplemented('list', 'M8'))

  program
    .command('why')
    .argument('<package>', 'the package to explain')
    .description('explain why a package is installed and which version won')
    .action(notYetImplemented('why', 'M8'))

  program
    .command('dedupe')
    .description('report packages installed at more than one version')
    .action(notYetImplemented('dedupe', 'M8'))

  await program.parseAsync([...argv])
}

/**
 * Stub for a command whose layer is not built yet.
 *
 * Naming the milestone keeps `rarn --help` honest about what already works instead
 * of failing in a way that reads like a bug.
 */
function notYetImplemented(command: string, milestone: string) {
  return () => {
    throw new RarnError({
      code: Code.Unimplemented,
      what: `'rarn ${command}' is not implemented yet.`,
      how: `It arrives in ${milestone}. See PLAN.md for the current state.`,
    })
  }
}

// Wrapped rather than a top-level await: `bun build --bytecode` emits CommonJS,
// which has no top-level await, so leaving it bare breaks the compiled binary
// while the interpreted entry point keeps working.
void (async () => {
  try {
    await main(process.argv)
  } catch (error) {
    process.stderr.write(`${renderError(error)}\n`)
    process.exitCode = error instanceof RegistryError ? ExitCode.RegistryError : ExitCode.UserError
  }
})()
