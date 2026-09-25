import { createHash } from 'node:crypto'
import { Code } from '../util/codes.ts'
import { RarnError } from '../util/errors.ts'

/**
 * Subresource-Integrity style digests: `sha256-<base64>`.
 *
 * The prefix is not decoration — it makes the algorithm part of the recorded value,
 * so a future move to a different hash can be told apart from a corrupt entry rather
 * than being read as one.
 */
const PREFIX = 'sha256-'

export function computeIntegrity(bytes: Uint8Array): string {
  return PREFIX + createHash('sha256').update(bytes).digest('base64')
}

export function isIntegrityString(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length
}

/**
 * Refuses a recorded digest that is not one, before anything is compared against it.
 *
 * Separate from `verifyIntegrity` so the cache can ask it first. Compared against a
 * cached archive, a malformed digest reads as a cache that disagrees with the lockfile,
 * and that starts a repair. No entry is lost to it — nothing cached is removed unless
 * the registry serves different bytes — but it misdirects. Online it spends a request
 * that can only arrive back at this error. Offline there is no request to make, so the
 * lockfile's defect surfaces as RN0130 and a cached copy that "does not match rarn.lock",
 * pointing the reader at the network and the cache, neither of which is at fault.
 */
export function assertIntegrityString(expected: string, subject: string): void {
  if (isIntegrityString(expected)) return
  throw new RarnError({
    code: Code.LockfileInvalid,
    what: `The recorded integrity for ${subject} is not a sha256 digest.`,
    where: subject,
    detail: `  found: ${expected}`,
    how: 'Delete rarn.lock and reinstall to regenerate it.',
  })
}

/**
 * Verifies bytes the registry has just served against a recorded digest.
 *
 * Wally records a `checksum` field but never fills it in, so its lockfiles carry no
 * integrity at all. Rarn checks on every install, which is the point of writing one
 * down: a lockfile that pins a version but not its contents pins nothing that matters
 * if the registry ever serves different bytes for the same version.
 *
 * Only for a fresh download, because the message names the registry. A cached archive
 * that disagrees has not been anywhere near it — that is local, and the cache store
 * repairs it by downloading, which is how it ends up here if the registry disagrees too.
 * `context` is what the store knows about its own copy by then, which the two digests
 * here cannot say.
 */
export function verifyIntegrity(
  bytes: Uint8Array,
  expected: string,
  subject: string,
  context?: readonly string[],
): void {
  assertIntegrityString(expected, subject)

  const actual = computeIntegrity(bytes)
  if (actual === expected) return

  throw new RarnError({
    code: Code.IntegrityMismatch,
    what: `${subject} does not match the integrity recorded in rarn.lock.`,
    where: subject,
    detail: [
      `  expected: ${expected}`,
      `  actual:   ${actual}`,
      ...(context === undefined ? [] : ['', ...context]),
    ].join('\n'),
    how: 'The registry served different bytes than the lockfile recorded. Do not install this until you know why. If the version was legitimately republished, delete rarn.lock and reinstall.',
  })
}
