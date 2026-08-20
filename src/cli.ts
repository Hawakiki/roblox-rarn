#!/usr/bin/env bun
import { Command } from 'commander'
import pkg from '../package.json' with { type: 'json' }
import { add } from './cli/commands/add.ts'
import { cache } from './cli/commands/cache.ts'
import { dedupe } from './cli/commands/dedupe.ts'
import { doctor } from './cli/commands/doctor.ts'
import { info } from './cli/commands/info.ts'
import { init } from './cli/commands/init.ts'
import { install } from './cli/commands/install.ts'
import { list } from './cli/commands/list.ts'
import { login } from './cli/commands/login.ts'
import { logout } from './cli/commands/logout.ts'
import { outdated } from './cli/commands/outdated.ts'
import { pack } from './cli/commands/pack.ts'
import { publish } from './cli/commands/publish.ts'
import { remove } from './cli/commands/remove.ts'
import { search } from './cli/commands/search.ts'
import { up } from './cli/commands/up.ts'
import { whoami } from './cli/commands/whoami.ts'
import { why } from './cli/commands/why.ts'
import { configureOutput } from './cli/output.ts'
import { exitCodeFor, renderError } from './cli/render.ts'

/**
 * Command wiring only. Every command body delegates immediately — business logic
 * lives in the layer modules so it stays reachable from tests without a process.
 */
async function main(argv: readonly string[]): Promise<void> {
  // Applied once up front so that anything printed before a command runs — a
  // parse error, --help — already respects TTY detection and NO_COLOR. The hook
  // below re-applies it with the parsed flags.
  configureOutput({})

  const program = new Command()

  program
    .name('rarn')
    .description('A package manager for Roblox that speaks the Wally registry')
    .version(pkg.version, '-v, --version')
    .option('--cwd <path>', 'run as if started in this directory', process.cwd())
    .option('--verbose', 'show every step', false)
    .option('--silent', 'print only errors', false)
    .option('--no-color', 'disable colored output')
    // Applied before any command runs so that every later print, including the
    // error renderer, sees the same switches.
    .hook('preAction', () => {
      configureOutput(program.opts())
    })

  program
    .command('init')
    .description('create a rarn.json in the current directory')
    .option('-y, --yes', 'accept the defaults without prompting', false)
    .option('-f, --force', 'overwrite an existing rarn.json', false)
    .action(async (options: { yes: boolean; force: boolean }) => {
      const { cwd } = program.opts<{ cwd: string }>()
      await init({ cwd, yes: options.yes, force: options.force })
    })

  program
    .command('add')
    .argument('<packages...>', 'packages to add, e.g. @evaera/promise or @evaera/promise@^4.0.0')
    .description('add packages to the manifest and install them')
    .option('-D, --dev', 'add as a development dependency', false)
    .option('--server', 'add as a server dependency', false)
    .option('-E, --exact', 'write the exact version instead of a caret range', false)
    .action(async (specs: string[], options: { dev: boolean; server: boolean; exact: boolean }) => {
      const { cwd } = program.opts<{ cwd: string }>()
      await add({ cwd, specs, dev: options.dev, server: options.server, exact: options.exact })
    })

  program
    .command('install', { isDefault: true })
    .description('install everything the manifest asks for')
    .option('--frozen-lockfile', 'fail instead of updating a stale lockfile', false)
    .option('--production', 'skip development dependencies', false)
    .action(async (options: { production: boolean; frozenLockfile: boolean }) => {
      const { cwd } = program.opts<{ cwd: string }>()
      await install({
        cwd,
        production: options.production,
        frozenLockfile: options.frozenLockfile,
      })
    })

  program
    .command('remove')
    .argument('<packages...>', 'packages to remove')
    .description('remove packages from the manifest and reinstall')
    .action(async (specs: string[]) => {
      await remove({ cwd: cwdOf(program), specs })
    })

  program
    .command('up')
    .argument('[packages...]', 'packages to upgrade; all of them when omitted')
    .description('raise the ranges in rarn.json to the newest allowed version')
    .option('--latest', 'ignore the declared range and take the newest release', false)
    .action(async (specs: string[], options: { latest: boolean }) => {
      await up({ cwd: cwdOf(program), specs, latest: options.latest })
    })

  program
    .command('list')
    .alias('ls')
    .description('show the installed dependency tree')
    .option('--depth <n>', 'how deep to print', Number.parseInt)
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { depth?: number; json: boolean }) => {
      await list({
        cwd: cwdOf(program),
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        json: options.json,
      })
    })

  program
    .command('why')
    .argument('<package>', 'the package to explain')
    .description('explain why a package is installed, tracing back to rarn.json')
    .option('--json', 'emit machine-readable output', false)
    .action(async (spec: string, options: { json: boolean }) => {
      await why({ cwd: cwdOf(program), spec, json: options.json })
    })

  program
    .command('dedupe')
    .description('report packages installed at more than one version')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { json: boolean }) => {
      await dedupe({ cwd: cwdOf(program), json: options.json })
    })

  program
    .command('search')
    .argument('<query>', 'text to search the registry for')
    .description('search the registry for packages')
    .option('--limit <n>', 'how many results to show', Number.parseInt)
    .option('--json', 'emit machine-readable output', false)
    .action(async (query: string, options: { limit?: number; json: boolean }) => {
      await search({
        cwd: cwdOf(program),
        query,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        json: options.json,
      })
    })

  program
    .command('info')
    .argument('<package>', 'package to describe, optionally @version')
    .description('show what the registry knows about a package')
    .option('--json', 'emit machine-readable output', false)
    .action(async (spec: string, options: { json: boolean }) => {
      await info({ cwd: cwdOf(program), spec, json: options.json })
    })

  program
    .command('outdated')
    .description('compare installed direct dependencies against the registry')
    .option('--check', 'exit non-zero when anything is out of date', false)
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { check: boolean; json: boolean }) => {
      await outdated({ cwd: cwdOf(program), check: options.check, json: options.json })
    })

  program
    .command('cache')
    .argument('<action>', 'dir, clean, or verify')
    .description('inspect, empty, or check the global package cache')
    .option('-y, --yes', 'skip the confirmation on clean', false)
    .option('--json', 'emit machine-readable output', false)
    .action(async (action: string, options: { yes: boolean; json: boolean }) => {
      await cache({
        cwd: cwdOf(program),
        action: action as 'dir' | 'clean' | 'verify',
        yes: options.yes,
        json: options.json,
      })
    })

  program
    .command('doctor')
    .description('check installed sources against the dependencies they declared')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { json: boolean }) => {
      await doctor({ cwd: cwdOf(program), json: options.json })
    })

  program
    .command('login')
    .description('sign in to the registry with a GitHub account')
    .option('--force', 'sign in again even if a token is already stored', false)
    .action(async (options: { force: boolean }) => {
      await login({ cwd: cwdOf(program), force: options.force })
    })

  program
    .command('logout')
    .description('forget the stored registry token')
    .action(async () => {
      await logout({ cwd: cwdOf(program) })
    })

  program
    .command('whoami')
    .description('show who the stored token belongs to')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { json: boolean }) => {
      await whoami({ cwd: cwdOf(program), json: options.json })
    })

  program
    .command('pack')
    .description('build the archive that publish would upload')
    .option('--list', 'print every file that would be included', false)
    .option('-o, --out <file>', 'write the archive to a file')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { list: boolean; out?: string; json: boolean }) => {
      await pack({
        cwd: cwdOf(program),
        list: options.list,
        ...(options.out === undefined ? {} : { out: options.out }),
        json: options.json,
      })
    })

  program
    .command('publish')
    .description('upload this package to the registry')
    .option('--dry-run', 'do everything except the upload', false)
    .action(async (options: { dryRun: boolean }) => {
      await publish({ cwd: cwdOf(program), dryRun: options.dryRun })
    })

  await program.parseAsync([...argv])
}

function cwdOf(program: Command): string {
  return program.opts<{ cwd: string }>().cwd
}

// Wrapped rather than a top-level await: `bun build --bytecode` emits CommonJS,
// which has no top-level await, so leaving it bare breaks the compiled binary
// while the interpreted entry point keeps working.
void (async () => {
  try {
    await main(process.argv)
  } catch (error) {
    // Empty for --help and --version, which commander implements by throwing.
    const text = renderError(error)
    if (text !== '') process.stderr.write(`${text}\n`)
    process.exitCode = exitCodeFor(error)
  }
})()
