/**
 * Wally against Rarn, on real packages from the live registry.
 *
 * Run with `bun test/benchmark/bench.ts`. It is not part of `bun test` — it needs the
 * network, it needs `wally` on PATH, and it takes minutes. The numbers it prints go in
 * `README.md` next to it, by hand, with the machine they came from.
 *
 * What it is careful about, because a benchmark that is not is worse than none:
 *
 * - **The two manifests must mean the same thing.** Wally reads Cargo ranges, where a
 *   bare `1.2.3` is `^1.2.3`; `rarn.json` reads npm, where the same text is an exact
 *   pin. Both are written with an explicit `^` so the difference cannot creep in.
 * - **Rarn's cache is redirected** with `RARN_CACHE_DIR` so a cold run is genuinely cold
 *   and the developer's real cache is never touched.
 * - **Wally's index clone is left alone.** It is a one-time 46 MB git clone; deleting it
 *   to make every run pay for it would be measuring the wrong thing. Its cost is
 *   reported separately, once.
 * - **Best-of-N**, not mean. The interesting quantity is what the tool can do, not what
 *   the machine was doing at the time.
 */

import { spawnSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

interface Candidate {
  readonly name: string
  readonly version: string
  readonly alias: string
}

interface Timing {
  readonly ms: number
  readonly files: number
  readonly bytes: number
}

const HERE = import.meta.dir
const SET = JSON.parse(await Bun.file(join(HERE, 'packages.json')).text()) as Candidate[]

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=')
      return [k, v ?? 'true'] as const
    }),
)

const SIZES = (args.get('sizes') ?? '10,50,150,506').split(',').map(Number)
const WARM_RUNS = Number(args.get('warm') ?? 3)

const WALLY = args.get('wally') ?? findWally()
const RARN = args.get('rarn') ?? 'bun'
const RARN_ARGS =
  args.get('rarn') === undefined ? ['run', join(HERE, '..', '..', 'src', 'cli.ts')] : []

function findWally(): string {
  const shim = join(
    homedir(),
    '.rokit',
    'tool-storage',
    'upliftgames',
    'wally',
    '0.3.2',
    'wally.exe',
  )
  return existsSync(shim) ? shim : 'wally'
}

function existsSync(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function measure(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (at: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        files++
        bytes += statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function run(cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const started = performance.now()
  const out = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8' })
  const ms = performance.now() - started
  if (out.status !== 0) {
    const how = out.status === null ? 'was killed by a signal' : `exited ${out.status}`
    throw new Error(`${cmd} ${argv.join(' ')} ${how}\n${out.stdout}\n${out.stderr}`)
  }
  return ms
}

function writeManifests(dir: string, set: readonly Candidate[]): void {
  writeFileSync(
    join(dir, 'wally.toml'),
    [
      '[package]',
      'name = "bench/set"',
      'version = "0.1.0"',
      'registry = "https://github.com/UpliftGames/wally-index"',
      'realm = "shared"',
      '',
      '[place]',
      'shared-packages = "game.ReplicatedStorage.Packages"',
      'server-packages = "game.ServerScriptService.ServerPackages"',
      '',
      '[dependencies]',
      // Explicit caret: Cargo reads a bare version as one, npm reads it as a pin.
      ...set.map((e) => `${e.alias} = "${e.name}@^${e.version}"`),
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(dir, 'rarn.json'),
    `${JSON.stringify(
      {
        name: '@bench/set',
        version: '0.1.0',
        realm: 'shared',
        place: {
          sharedPackages: 'game.ReplicatedStorage.Packages',
          serverPackages: 'game.ServerScriptService.ServerPackages',
        },
        dependencies: Object.fromEntries(set.map((e) => [`@${e.name}`, `^${e.version}`])),
        aliases: Object.fromEntries(set.map((e) => [`@${e.name}`, e.alias])),
      },
      null,
      2,
    )}\n`,
  )
}

function best(times: readonly number[]): number {
  return Math.min(...times)
}

function benchSize(size: number) {
  const set = SET.slice(0, size)
  const dir = mkdtempSync(join(tmpdir(), `rarn-bench-${size}-`))
  writeManifests(dir, set)

  const cache = mkdtempSync(join(tmpdir(), 'rarn-bench-cache-'))
  const rarnEnv = { ...process.env, RARN_CACHE_DIR: cache, NO_COLOR: '1' }

  // --- Rarn, cold: empty cache, no lockfile -------------------------------
  const rarnCold = run(RARN, [...RARN_ARGS, 'install'], dir, rarnEnv)
  const rarnDisk = measure(join(dir, 'RARN_MODULE'))
  const rarnServer = measure(join(dir, 'RARN_MODULE_SERVER'))

  // --- Rarn, warm: cache and lockfile both present -------------------------
  const rarnWarm: number[] = []
  for (let i = 0; i < WARM_RUNS; i++)
    rarnWarm.push(run(RARN, [...RARN_ARGS, 'install'], dir, rarnEnv))

  // --- Wally: it has no package cache, so every run is the same run --------
  const wally: number[] = []
  let wallyDisk = { files: 0, bytes: 0 }
  for (let i = 0; i < WARM_RUNS; i++) {
    rmSync(join(dir, 'Packages'), { recursive: true, force: true })
    rmSync(join(dir, 'ServerPackages'), { recursive: true, force: true })
    rmSync(join(dir, 'wally.lock'), { force: true })
    wally.push(run(WALLY, ['install'], dir, { ...process.env, NO_COLOR: '1' }))
    if (i === 0) {
      const shared = measure(join(dir, 'Packages'))
      const server = measure(join(dir, 'ServerPackages'))
      wallyDisk = { files: shared.files + server.files, bytes: shared.bytes + server.bytes }
    }
  }

  rmSync(cache, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })

  return {
    size,
    rarn: {
      cold: { ms: rarnCold, ...addDisk(rarnDisk, rarnServer) } satisfies Timing,
      warm: { ms: best(rarnWarm), ...addDisk(rarnDisk, rarnServer) } satisfies Timing,
    },
    wally: { ms: best(wally), ...wallyDisk } satisfies Timing,
  }
}

function addDisk(a: { files: number; bytes: number }, b: { files: number; bytes: number }) {
  return { files: a.files + b.files, bytes: a.bytes + b.bytes }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)

mkdirSync(join(HERE, 'results'), { recursive: true })
const rows = []
for (const size of SIZES) {
  process.stderr.write(`  ${size} packages...\n`)
  const row = benchSize(size)
  rows.push(row)
  process.stderr.write(
    `    rarn cold ${secs(row.rarn.cold.ms)}  warm ${secs(row.rarn.warm.ms)}  |  wally ${secs(row.wally.ms)}\n`,
  )
}

const lines = [
  '| direct deps | rarn (cold) | rarn (warm) | wally | rarn files | wally files | rarn on disk | wally on disk |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(
    (r) =>
      `| ${r.size} | ${secs(r.rarn.cold.ms)} | **${secs(r.rarn.warm.ms)}** | ${secs(r.wally.ms)} | ${r.rarn.warm.files} | ${r.wally.files} | ${mb(r.rarn.warm.bytes)} | ${mb(r.wally.bytes)} |`,
  ),
]
console.log(lines.join('\n'))
writeFileSync(join(HERE, 'results', 'latest.json'), `${JSON.stringify(rows, null, 2)}\n`)
