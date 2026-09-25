/**
 * Wally against Rarn, on real packages from the live registry.
 *
 * Run with `bun test/benchmark/bench.ts`. It is not part of `bun test` — it needs the
 * network, it needs `wally` on PATH, and it takes minutes.
 *
 * What it is careful about, because a benchmark that is not is worse than none:
 *
 * - **The two manifests must mean the same thing.** Wally reads Cargo ranges, where a
 *   bare `1.2.3` is `^1.2.3`; `rarn.json` reads npm, where the same text is an exact
 *   pin. Both are written with an explicit `^` so the difference cannot creep in.
 * - **Rarn's cache is redirected** with `RARN_CACHE_DIR` so a cold run is genuinely cold
 *   and the developer's real cache is never touched.
 * - **Wally's index clone is left alone.** It is a one-time 46 MB git clone; deleting it
 *   to make every run pay for it would be measuring the wrong thing.
 *
 * ## What R3 found wrong with the previous version, and what changed
 *
 * [R3](../../docs/research/r3-performance.md) audited this file and concluded the table
 * it produced **was not a reproducible record**. Four defects, all fixed here, and a
 * fifth that R3 could not have known about because it did not exist yet:
 *
 * 1. **Cold was measured once** and printed with no n. Every cell now carries its own
 *    sample count, median and spread, and the count appears in the generated table.
 * 2. **Best-of-N threw the other samples away**, so no published number had a spread —
 *    which is the one thing that says whether a difference is real. Median now, with
 *    min and max beside it, and every raw sample kept in the results file.
 * 3. **The default command was `bun run src/cli.ts`** while the recorded table had been
 *    measured with `--rarn=dist/rarn.exe`. The two are not comparable and nothing said
 *    which produced the numbers. The binary is now the default when it exists, what ran
 *    is recorded, and **a binary older than the newest change under `src/` is reported
 *    as stale** — which is exactly how the published table came to be measured on a
 *    pre-M7 build without anyone noticing.
 * 4. **`results/` was gitignored**, so the published numbers had no committed raw data
 *    and the file on disk was from a different run than the table. Results are committed
 *    now, and **the table is generated rather than transcribed** — a hand-copied table
 *    can drift from its data and this one had.
 * 5. **The first warm run stopped being like the others.** Since the retired tree is
 *    deleted by the *next* install rather than by the one that retires it, warm run 1
 *    has nothing to clear and runs 2+ do. Best-of-N picked run 1 every time — the one
 *    run that is not the steady state. An untimed priming install now runs first.
 *
 * And one thing R3 asked for that is not about any single number: **the machine is
 * measured too.** A fixed probe runs before and after the suite, because during the R3
 * session the same command drifted +9.5% in an hour with the repository untouched. A
 * comparison that does not record that is comparing machines, not tools.
 */

import { spawnSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

interface Candidate {
  readonly name: string
  readonly version: string
  readonly alias: string
}

/** Every sample kept, so a reader can check the summary rather than trust it. */
interface Series {
  readonly samples: readonly number[]
  readonly discarded: readonly number[]
  readonly medianMs: number
  readonly minMs: number
  readonly maxMs: number
  readonly n: number
}

interface Cell {
  readonly time: Series
  readonly files: number
  readonly bytes: number
}

const HERE = import.meta.dir
const ROOT = join(HERE, '..', '..')
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
const WARM_RUNS = Number(args.get('warm') ?? 5)
const COLD_RUNS = Number(args.get('cold') ?? 3)
const WALLY_RUNS = Number(args.get('wally-runs') ?? 3)
/** Dropped from the front of every series; the first run of anything is not the others. */
const DISCARD = Number(args.get('discard') ?? 1)

const WALLY = args.get('wally') ?? findWally()
const RARN_CHOICE = resolveRarn()

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
  return exists(shim) ? shim : 'wally'
}

/**
 * Which Rarn to time, and whether it can be trusted to represent this commit.
 *
 * The compiled binary is the default because it is what a user runs and what Wally is —
 * `bun run src/cli.ts` transpiles the whole module graph on every launch and is not a
 * thing to compare against a compiled tool. But a binary is a *build*, and a build goes
 * stale silently: the table published in README was measured on one that predated M7,
 * which nothing recorded and nobody noticed until R3 checked the commit dates.
 */
function resolveRarn(): {
  command: string
  argv: readonly string[]
  kind: 'binary' | 'source'
  builtAt?: string
  stale?: string
} {
  const explicit = args.get('rarn')
  if (explicit !== undefined && explicit !== 'true') {
    return { command: explicit, argv: [], kind: 'binary', ...staleness(explicit) }
  }

  const binary = join(ROOT, 'dist', platform() === 'win32' ? 'rarn.exe' : 'rarn')
  if (args.get('source') === undefined && exists(binary)) {
    return { command: binary, argv: [], kind: 'binary', ...staleness(binary) }
  }

  return { command: 'bun', argv: ['run', join(ROOT, 'src', 'cli.ts')], kind: 'source' }
}

/** A build older than the newest change under `src/` is not this commit's Rarn. */
function staleness(binary: string): { builtAt?: string; stale?: string } {
  const built = statSync(binary).mtime
  const newest = capture('git', ['log', '-1', '--format=%cI', '--', 'src', 'schemas'])
  if (newest === undefined) return { builtAt: built.toISOString() }

  const sourceAt = new Date(newest.trim())
  if (built >= sourceAt) return { builtAt: built.toISOString() }

  return {
    builtAt: built.toISOString(),
    stale: `built ${built.toISOString()}, newest src/schemas commit ${sourceAt.toISOString()} — run \`bun run build\``,
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function capture(cmd: string, argv: readonly string[]): string | undefined {
  const out = spawnSync(cmd, [...argv], { cwd: ROOT, encoding: 'utf8' })
  return out.status === 0 ? out.stdout : undefined
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

function run(cmd: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const started = performance.now()
  const out = spawnSync(cmd, [...argv], { cwd, env, encoding: 'utf8' })
  const ms = performance.now() - started
  if (out.status !== 0) {
    const how = out.status === null ? 'was killed by a signal' : `exited ${out.status}`
    throw new Error(`${cmd} ${argv.join(' ')} ${how}\n${out.stdout}\n${out.stderr}`)
  }
  return ms
}

/**
 * Median with the spread beside it, and the discarded warm-up kept rather than deleted.
 *
 * The previous version reported `Math.min` and dropped everything else, on the reasoning
 * that the interesting quantity is what the tool can do rather than what the machine was
 * doing. That reasoning is fine and the consequence was not: with only a best, no reader
 * can tell a 5% difference that is real from a 5% difference that is the machine. R3
 * measured this machine drifting 9.5% in an hour with nothing changed.
 */
function series(all: readonly number[], discard: number): Series {
  const discarded = all.slice(0, discard)
  const samples = all.slice(discard)
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
  return {
    samples,
    discarded,
    medianMs: mid,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    n: samples.length,
  }
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

function benchSize(size: number) {
  const set = SET.slice(0, size)
  const dir = mkdtempSync(join(tmpdir(), `rarn-bench-${size}-`))
  writeManifests(dir, set)

  const { command, argv } = RARN_CHOICE
  const install = [...argv, 'install']

  // --- Rarn, cold: empty cache, no lockfile --------------------------------
  // A fresh cache directory per sample, because emptying one is not the same as never
  // having had one — and the lockfile has to go too, or the second sample resolves from
  // it and measures something else entirely.
  const cold: number[] = []
  let rarnDisk = { files: 0, bytes: 0 }
  for (let i = 0; i < COLD_RUNS + DISCARD; i++) {
    const cache = mkdtempSync(join(tmpdir(), 'rarn-bench-cache-'))
    rmSync(join(dir, 'rarn.lock'), { force: true })
    rmSync(join(dir, 'RARN_MODULE'), { recursive: true, force: true })
    rmSync(join(dir, 'RARN_MODULE_SERVER'), { recursive: true, force: true })
    cold.push(run(command, install, dir, { ...process.env, RARN_CACHE_DIR: cache, NO_COLOR: '1' }))
    if (i === 0) {
      rarnDisk = addDisk(
        measure(join(dir, 'RARN_MODULE')),
        measure(join(dir, 'RARN_MODULE_SERVER')),
      )
    }
    rmSync(cache, { recursive: true, force: true })
  }

  // --- Rarn, warm: cache and lockfile both present -------------------------
  // Primed with one untimed install *beyond* the discard, because the install that
  // retires a tree no longer deletes it — the next one does. Without priming, the first
  // timed run is the only one with nothing to clear, and it is not the steady state.
  const warmCache = mkdtempSync(join(tmpdir(), 'rarn-bench-cache-'))
  const warmEnv = { ...process.env, RARN_CACHE_DIR: warmCache, NO_COLOR: '1' }
  run(command, install, dir, warmEnv)
  run(command, install, dir, warmEnv)

  const warm: number[] = []
  for (let i = 0; i < WARM_RUNS + DISCARD; i++) warm.push(run(command, install, dir, warmEnv))
  const warmDisk = addDisk(
    measure(join(dir, 'RARN_MODULE')),
    measure(join(dir, 'RARN_MODULE_SERVER')),
  )
  rmSync(warmCache, { recursive: true, force: true })

  // --- Wally: it has no package cache, so every run is the same run --------
  const wally: number[] = []
  let wallyDisk = { files: 0, bytes: 0 }
  for (let i = 0; i < WALLY_RUNS + DISCARD; i++) {
    rmSync(join(dir, 'Packages'), { recursive: true, force: true })
    rmSync(join(dir, 'ServerPackages'), { recursive: true, force: true })
    rmSync(join(dir, 'wally.lock'), { force: true })
    wally.push(run(WALLY, ['install'], dir, { ...process.env, NO_COLOR: '1' }))
    if (i === 0) {
      wallyDisk = addDisk(measure(join(dir, 'Packages')), measure(join(dir, 'ServerPackages')))
    }
  }

  rmSync(dir, { recursive: true, force: true })

  return {
    size,
    rarn: {
      cold: { time: series(cold, DISCARD), ...rarnDisk } satisfies Cell,
      warm: { time: series(warm, DISCARD), ...warmDisk } satisfies Cell,
    },
    wally: { time: series(wally, DISCARD), ...wallyDisk } satisfies Cell,
  }
}

function addDisk(a: { files: number; bytes: number }, b: { files: number; bytes: number }) {
  return { files: a.files + b.files, bytes: a.bytes + b.bytes }
}

/**
 * A fixed unit of CPU and filesystem work, run before and after the suite.
 *
 * Not a benchmark of anything — a witness. If these two disagree by more than a few
 * percent the machine moved during the run, and every comparison in the table is partly
 * a comparison of machines. R3 caught exactly that: the same harness command, the same
 * commit, an hour apart, 56.9ms and 62.3ms.
 */
function probe(): number {
  const started = performance.now()
  let sum = 0
  for (let i = 0; i < 3_000_000; i++) sum += i % 7
  const dir = mkdtempSync(join(tmpdir(), 'rarn-bench-probe-'))
  for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}`), 'x'.repeat(512))
  measure(dir)
  rmSync(dir, { recursive: true, force: true })
  if (sum < 0) throw new Error('unreachable')
  return performance.now() - started
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)
const spread = (s: Series) =>
  `${secs(s.medianMs)} <sub>${secs(s.minMs)}–${secs(s.maxMs)} n=${s.n}</sub>`

const head = capture('git', ['rev-parse', 'HEAD'])?.trim()
const dirty = (capture('git', ['status', '--porcelain']) ?? '').trim() !== ''
const cpu = cpus()[0]?.model ?? 'unknown'

const provenance = {
  commit: head ?? 'unknown',
  dirty,
  at: new Date().toISOString(),
  os: `${platform()} ${release()} ${arch()}`,
  cpu,
  cores: cpus().length,
  ramGB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  bun: Bun.version,
  wally: (capture(WALLY, ['--version']) ?? 'unknown').trim(),
  rarn: {
    kind: RARN_CHOICE.kind,
    command: `${RARN_CHOICE.command} ${RARN_CHOICE.argv.join(' ')}`.trim(),
    version: (capture(RARN_CHOICE.command, [...RARN_CHOICE.argv, '--version']) ?? 'unknown').trim(),
    builtAt: RARN_CHOICE.builtAt,
    stale: RARN_CHOICE.stale,
  },
  samples: { cold: COLD_RUNS, warm: WARM_RUNS, wally: WALLY_RUNS, discarded: DISCARD },
}

// Said before anything runs rather than buried in the output. A stale binary does not
// stop the run — sometimes measuring an old build is the point — but a table produced
// from one must say so, and this is where the operator finds out in time to rebuild.
if (RARN_CHOICE.stale !== undefined) {
  process.stderr.write(`\n  ! dist binary is STALE: ${RARN_CHOICE.stale}\n`)
}
if (dirty)
  process.stderr.write('  ! working tree is dirty; the commit below does not describe it\n')

// The registry is a free community service and a cold run is the expensive kind. The
// estimate is deliberately printed before the first request rather than after the last.
const requests = SIZES.reduce((total, size) => total + size * 2 * (COLD_RUNS + DISCARD), 0)
process.stderr.write(
  `\n  ${RARN_CHOICE.kind} · commit ${(head ?? '???').slice(0, 8)}${dirty ? '+dirty' : ''}\n` +
    `  cold n=${COLD_RUNS}, warm n=${WARM_RUNS}, wally n=${WALLY_RUNS}, discard ${DISCARD}\n` +
    `  roughly ${requests} requests to api.wally.run — pass --cold=1 to be gentler\n\n`,
)

const probeBefore = probe()
const rows = []
for (const size of SIZES) {
  process.stderr.write(`  ${size} packages...\n`)
  const row = benchSize(size)
  rows.push(row)
  process.stderr.write(
    `    rarn cold ${spread(row.rarn.cold.time)}  warm ${spread(row.rarn.warm.time)}  |  wally ${spread(row.wally.time)}\n`.replace(
      /<\/?sub>/g,
      '',
    ),
  )
}
const probeAfter = probe()
const drift = ((probeAfter - probeBefore) / probeBefore) * 100

const table = [
  '| 직접 의존 | rarn (콜드) | rarn (웜) | wally | rarn 파일 | wally 파일 | rarn 디스크 | wally 디스크 |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(
    (r) =>
      `| ${r.size} | ${spread(r.rarn.cold.time)} | **${spread(r.rarn.warm.time)}** | ${spread(r.wally.time)} | ${r.rarn.warm.files} | ${r.wally.files} | ${mb(r.rarn.warm.bytes)} | ${mb(r.wally.bytes)} |`,
  ),
  '',
  `> ${provenance.os} · ${provenance.cpu} · Bun ${provenance.bun} · Wally ${provenance.wally}`,
  `> Rarn: ${provenance.rarn.kind} ${provenance.rarn.version}${provenance.rarn.stale === undefined ? '' : ' **(STALE BUILD)**'} · commit \`${provenance.commit.slice(0, 8)}\`${dirty ? ' **(dirty tree)**' : ''} · ${provenance.at.slice(0, 10)}`,
  `> 중앙값, 아래첨자는 min–max 와 n. 첫 샘플 ${DISCARD}개는 버린다. 기계 드리프트 ${drift.toFixed(1)}%.`,
]

console.log(table.join('\n'))

mkdirSync(join(HERE, 'results'), { recursive: true })
writeFileSync(
  join(HERE, 'results', 'latest.json'),
  `${JSON.stringify({ provenance, machineDrift: { probeBefore, probeAfter, percent: drift }, rows }, null, 2)}\n`,
)
// Generated rather than transcribed. A table copied by hand drifts from its data, and
// the one this file used to print had: the committed README row said 3.17 s where the
// only raw file on disk said 3.08 s, from a different run nobody could identify.
writeFileSync(join(HERE, 'results', 'latest.md'), `${table.join('\n')}\n`)
