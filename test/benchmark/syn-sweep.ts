/**
 * How many connections this network answers at once.
 *
 * ```bash
 * bun test/benchmark/syn-sweep.ts --label=home
 * bun test/benchmark/syn-sweep.ts --label=phone-hotspot
 * ```
 *
 * ## Why this exists
 *
 * [R3](../../docs/research/r3-performance.md) §4.3 found that on the machine it ran on,
 * the 9th concurrent SYN goes unanswered: the client sits through a TCP retransmit ladder
 * and a 32-wide metadata wave costs 7.4 s where a 5 ms stagger between connection
 * attempts makes it 491 ms. That is the largest single lever the research found —
 * a measured ceiling of 3,366 ms on a cold 506-package install.
 *
 * **And it is not Rarn's, and possibly not yours.** The same cliff reproduces under Node,
 * against `raw.githubusercontent.com`, and against five destinations at once; the
 * allowance is machine-wide rather than per-origin, and `netsh int tcp show global`
 * reports the exact retransmit schedule that generates the measured staircase. It is a
 * property of the first hop out of that machine.
 *
 * The curve committed in CLAUDE.md — 150 packages, width 32 in 1.8 s — was measured on a
 * network where this limiter **did not exist**. So tuning `METADATA_CONCURRENCY` to the
 * cliff would ship one developer's home connection as a global default, and R3 left the
 * candidate at needs-more-measurement for exactly that reason.
 *
 * This is the missing measurement. Run it on a second network — a phone hotspot is the
 * cheapest real one — and the answer decides the shape of the fix:
 *
 * - **stall-free at 32 elsewhere** → a ramp must be conditional; unconditional it is pure
 *   cost (+127 ms once per process, measured on loopback)
 * - **stalls there too** → unconditional, and the constant itself is not the problem
 *
 * ## What it measures, and what it deliberately does not
 *
 * Raw TCP `connect`, no TLS and no HTTP, so nothing about a client, a runtime or a server
 * can be mistaken for the network. DNS is resolved once up front and every arm dials the
 * resolved address, so lookup latency is never inside a measured connect.
 *
 * A connect under `FIRST_TRY_MS` had its first SYN answered. Anything slower sat through
 * at least one retransmit — the initial RTO is 1 s on Windows by default, which is why
 * the threshold is well below that and not a tunable.
 *
 * It costs the origin one SYN/ACK per connection and sends no bytes, which is the reason
 * it is safe to point at a public host.
 */

import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=')
      return [k, v ?? 'true'] as const
    }),
)

const HOST = args.get('host') ?? 'api.wally.run'
const PORT = Number(args.get('port') ?? 443)
const WIDTHS = (args.get('widths') ?? '4,8,10,12,16,24,32,48').split(',').map(Number)
const REPS = Number(args.get('reps') ?? 3)
const STAGGER_MS = Number(args.get('stagger') ?? 5)
/** Well under the 1 s initial RTO, so it cannot be confused with a slow-but-answered SYN. */
const FIRST_TRY_MS = 700
const LABEL = args.get('label') ?? 'unlabelled'

interface Attempt {
  readonly ms: number
  readonly ok: boolean
}

interface Round {
  readonly width: number
  readonly wallMs: number
  readonly connected: number
  readonly failed: number
  readonly firstTry: number
  readonly p50: number | null
  readonly max: number | null
}

function capture(cmd: string, argv: readonly string[]): string | undefined {
  const out = spawnSync(cmd, [...argv], { encoding: 'utf8' })
  return out.status === 0 ? out.stdout : undefined
}

/**
 * Enough about the path to tell two runs apart later.
 *
 * Without this a second run is just another set of numbers — the whole point is to
 * compare *networks*, and a results file that cannot say which network it came from
 * answers nothing. The gateway address is the identifying bit; the TCP parameters are
 * what generate the retransmit staircase when SYNs go missing.
 */
function network(): Record<string, string> {
  const out: Record<string, string> = {}
  if (platform() !== 'win32') return out

  const route = capture('cmd', ['/c', 'route print 0.0.0.0']) ?? ''
  const gateway = /0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)/.exec(route)?.[1]
  if (gateway !== undefined) out.gateway = gateway

  const tcp = capture('netsh', ['int', 'tcp', 'show', 'global']) ?? ''
  const rto = /Initial RTO\s*:\s*(\d+)/i.exec(tcp)?.[1]
  const retrans = /Max SYN Retransmissions\s*:\s*(\d+)/i.exec(tcp)?.[1]
  if (rto !== undefined) out.initialRtoMs = rto
  if (retrans !== undefined) out.maxSynRetransmissions = retrans

  return out
}

/**
 * One wave: `width` connections opened together, each timed to its own `connect`.
 *
 * `staggerMs` delays each attempt by index rather than the whole wave, which is the
 * candidate fix stated as an experiment: the width is unchanged and only the instant of
 * the SYN moves.
 */
async function wave(address: string, width: number, staggerMs: number): Promise<Round> {
  const started = performance.now()

  const attempts = await Promise.all(
    Array.from(
      { length: width },
      (_, index) =>
        new Promise<Attempt>((resolve) => {
          const fire = () => {
            const socket = connect({ host: address, port: PORT })
            const at = performance.now()
            const done = (ok: boolean) => {
              socket.destroy()
              resolve({ ms: Number((performance.now() - at).toFixed(1)), ok })
            }
            socket.once('connect', () => {
              done(true)
            })
            socket.once('error', () => {
              done(false)
            })
            socket.setTimeout(30_000, () => {
              done(false)
            })
          }
          if (staggerMs > 0) setTimeout(fire, index * staggerMs)
          else fire()
        }),
    ),
  )

  const ok = attempts
    .filter((a) => a.ok)
    .map((a) => a.ms)
    .sort((a, b) => a - b)

  return {
    width,
    wallMs: Number((performance.now() - started).toFixed(1)),
    connected: ok.length,
    failed: width - ok.length,
    firstTry: ok.filter((ms) => ms < FIRST_TRY_MS).length,
    p50: ok[Math.floor(ok.length / 2)] ?? null,
    max: ok[ok.length - 1] ?? null,
  }
}

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const { address } = await lookup(HOST, { family: 4 })
const path = network()

process.stderr.write(
  `\n  ${LABEL} · ${HOST} → ${address}:${PORT}\n` +
    `  ${Object.entries(path)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ')}\n` +
    `  widths ${WIDTHS.join(',')} × ${REPS} reps, plus a ${STAGGER_MS}ms-stagger arm\n\n`,
)

// Rounds are interleaved rather than blocked by width, so a change in the path lands on
// every width instead of on whichever one happened to be running when it changed.
const rounds = new Map<number, Round[]>()
for (let rep = 0; rep < REPS; rep++) {
  for (const width of WIDTHS) {
    const list = rounds.get(width) ?? []
    list.push(await wave(address, width, 0))
    rounds.set(width, list)
    process.stderr.write('.')
  }
}

const staggered: Round[] = []
const widest = Math.max(...WIDTHS)
for (let rep = 0; rep < REPS; rep++) {
  staggered.push(await wave(address, widest, STAGGER_MS))
  process.stderr.write('+')
}
process.stderr.write('\n\n')

const rows = WIDTHS.map((width) => {
  const list = rounds.get(width) ?? []
  return {
    width,
    wallMedianMs: median(list.map((r) => r.wallMs)),
    firstTry: list.map((r) => r.firstTry),
    stallFree: list.every((r) => r.firstTry === width),
    failed: list.reduce((sum, r) => sum + r.failed, 0),
  }
})

const stallFree = rows.filter((r) => r.stallFree).map((r) => r.width)
const largest = stallFree.length > 0 ? Math.max(...stallFree) : null
const straightWidest = median((rounds.get(widest) ?? []).map((r) => r.wallMs))
const staggerWidest = median(staggered.map((r) => r.wallMs))

for (const row of rows) {
  process.stdout.write(
    `  width ${String(row.width).padStart(3)}  wall ${String(Math.round(row.wallMedianMs)).padStart(6)} ms  ` +
      `first-try ${row.firstTry.join('/')}${row.stallFree ? '  (stall-free)' : ''}\n`,
  )
}

process.stdout.write(
  `\n  largest stall-free width: ${largest ?? 'none — even the narrowest arm stalled'}\n` +
    `  width ${widest}: ${Math.round(straightWidest)} ms straight, ${Math.round(staggerWidest)} ms with a ${STAGGER_MS}ms stagger\n\n`,
)

// The whole reason for running this a second time, said plainly rather than left to the
// reader: the two possible answers imply different fixes, and one of them is "do nothing".
const verdict =
  largest !== null && largest >= widest
    ? `  This network answers ${widest} at once. If the other one does not, a connection ramp
  has to be conditional — here it would be cost with no benefit.
`
    : `  This network stalls above ${largest ?? '?'}. If the other one does too, the ramp is
  unconditional and the constant itself was never the problem.
`
process.stdout.write(verdict)

mkdirSync(join(HERE, 'results'), { recursive: true })
writeFileSync(
  join(HERE, 'results', `syn-sweep-${LABEL}.json`),
  `${JSON.stringify(
    {
      label: LABEL,
      at: new Date().toISOString(),
      host: HOST,
      address,
      port: PORT,
      machine: `${platform()} ${release()} ${arch()}`,
      runtime: `bun ${Bun.version}`,
      network: path,
      firstTryThresholdMs: FIRST_TRY_MS,
      reps: REPS,
      largestStallFreeWidth: largest,
      stagger: {
        ms: STAGGER_MS,
        width: widest,
        straightMs: straightWidest,
        staggeredMs: staggerWidest,
      },
      rows,
      rounds: Object.fromEntries(rounds),
      staggered,
    },
    null,
    2,
  )}\n`,
)
