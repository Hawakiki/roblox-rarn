import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Placement } from '../resolver/types.ts'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'
import { INDEX_DIR_NAME, type InstallLayout, SHIM_EXTENSION } from './layout.ts'
import { SHIM_MARKER } from './shim.ts'

const PLACEMENTS: readonly Placement[] = ['shared', 'server', 'dev']

/**
 * Refuses to install over a directory Rarn did not create.
 *
 * Installing replaces the realm directories wholesale, and until this existed the
 * only thing standing between that and a user's source tree was the *name*. On
 * Windows and macOS a name is not even that: the filesystem ignores case, so a
 * project with a `packages/` source directory and `packageDir: "Packages"` — which
 * is exactly what `rarn import` writes — had its source replaced by the install,
 * with no warning and a "installed N packages" success line. That shipped in 0.1.0
 * and is why 0.1.0 was withdrawn.
 *
 * The check runs before any work, not at swap time: failing after a download and a
 * prune is still correct but wastes the user's time to tell them something knowable
 * up front.
 *
 * **A Wally install passes.** It has `_Index/` too, and replacing it is the entire
 * point of migrating. What must not pass is a directory holding something else.
 */
export async function assertRealmsAreOurs(layout: InstallLayout): Promise<void> {
  for (const placement of PLACEMENTS) {
    const dir = layout.realms[placement]
    const verdict = await inspect(dir)
    if (verdict.ours) continue

    throw new RarnError({
      code: Code.InstallTargetNotOurs,
      what: `${basename(dir)}/ already exists and was not created by Rarn.`,
      where: dir,
      detail: [
        `  It holds ${verdict.why}.`,
        '  Installing replaces this directory entirely, so Rarn stopped instead.',
        ...(await caseCollisionNote(dir)),
      ].join('\n'),
      how: 'Point "packageDir" in rarn.json at a directory Rarn owns, or move this one aside if it really is an old install.',
    })
  }
}

interface Verdict {
  readonly ours: boolean
  /** What was found, phrased to drop into "It holds ___". */
  readonly why: string
}

const OURS: Verdict = { ours: true, why: '' }

async function inspect(dir: string): Promise<Verdict> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Absent is the common case and the safe one.
    return OURS
  }

  // An empty directory belongs to nobody, and refusing over one would be obstruction.
  if (entries.length === 0) return OURS

  // The marker of an install — ours or Wally's. Both are ours to replace.
  if (entries.includes(INDEX_DIR_NAME)) return OURS

  // No `_Index` yet: this is either a realm holding only root shims, or someone
  // else's directory. Reading stops at the first entry that is not a generated
  // shim, so the cost is bounded by how quickly the answer becomes clear.
  for (const entry of entries) {
    if (!entry.endsWith(SHIM_EXTENSION) && !entry.endsWith('.lua')) {
      return { ours: false, why: `${describe(entry)}, which Rarn does not generate` }
    }
    let source: string
    try {
      source = await readFile(join(dir, entry), 'utf8')
    } catch {
      return { ours: false, why: `${describe(entry)}, which Rarn could not read` }
    }
    if (!source.includes(SHIM_MARKER)) {
      return { ours: false, why: `${describe(entry)}, which Rarn did not write` }
    }
  }

  return OURS
}

function describe(entry: string): string {
  return `"${entry}"`
}

/**
 * Names the case collision when that is what happened.
 *
 * Without this the message is true but unhelpful on the path people actually hit:
 * the manifest says `Packages`, the directory on screen says `packages`, and the two
 * look like different directories to everyone except the filesystem.
 */
async function caseCollisionNote(dir: string): Promise<string[]> {
  const wanted = basename(dir)
  let siblings: string[]
  try {
    siblings = await readdir(dirname(dir))
  } catch {
    return []
  }

  const actual = siblings.find(
    (name) => name !== wanted && name.toLowerCase() === wanted.toLowerCase(),
  )
  if (actual === undefined) return []

  return [
    '',
    `  The directory on disk is "${actual}", and "packageDir" says "${wanted}".`,
    '  This filesystem ignores case, so those are one directory, not two.',
  ]
}

/** Whether a case-only variant of `packageDir` already exists in the project. */
export async function findCaseVariant(
  projectDir: string,
  packageDir: string,
): Promise<string | undefined> {
  try {
    const entries = await readdir(projectDir)
    return entries.find(
      (name) => name !== packageDir && name.toLowerCase() === packageDir.toLowerCase(),
    )
  } catch {
    return undefined
  }
}
