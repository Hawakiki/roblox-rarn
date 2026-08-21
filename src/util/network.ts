import { Code } from './codes.ts'
import { RarnError } from './errors.ts'

/**
 * Set to anything other than `0` to forbid every outbound request Rarn makes.
 *
 * CI sets it. The test suite is offline by construction — every test injects its
 * own fetch — but that is a convention, and a convention is enforced by whoever
 * remembers it. One test that calls the real registry would pass locally, pass in
 * review, and only show up later as a CI run that fails whenever api.wally.run is
 * having a bad day. With this set, that test fails immediately and says why.
 */
export const NO_NETWORK_ENV = 'RARN_NO_NETWORK'

/**
 * `0` and the empty string mean off, anything else means on.
 *
 * Unlike `NO_COLOR`, which is on when merely present, this reads its value —
 * `RARN_NO_NETWORK=0` in a CI job that needs one online step has to be able to
 * turn the block back off, and unsetting a variable is not always available where
 * setting one is.
 */
export function networkBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  if (byFlag) return true
  const value = env[NO_NETWORK_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

/**
 * Whether `--offline` was passed, as opposed to the environment variable.
 *
 * Tracked separately only so the error can name the thing the reader actually did.
 * "Unset RARN_NO_NETWORK" is unhelpful advice to someone who typed `--offline`, and
 * being told to change something they never set is how a reader concludes the tool
 * has misdiagnosed them and stops reading the rest of the message.
 */
let byFlag = false

export function blockNetwork(): void {
  byFlag = true
}

/** Test seam. Nothing in the CLI turns the block back off mid-run. */
export function unblockNetwork(): void {
  byFlag = false
}

/**
 * Not a `RegistryError`, so this exits 1 rather than 2.
 *
 * Exit 2 means "the network failed, retrying might help". Nothing failed here and
 * retrying will produce exactly this again — the machine was told not to go out.
 * A CI job that retries on 2 would otherwise loop on a decision it made itself.
 */
export function networkBlockedError(url: string): RarnError {
  const cause = byFlag ? '`--offline` was passed' : `${NO_NETWORK_ENV} is set`
  const how = byFlag
    ? 'Run without `--offline`. An install is fully offline when rarn.lock is up to date and every package is already cached — anything that has to ask the registry, such as a search or a new version, cannot be.'
    : `Unset ${NO_NETWORK_ENV} to allow it. If this is CI, the code under test tried to reach the network — give it a fetch stand-in instead.`

  return new RarnError({
    code: Code.NetworkBlocked,
    what: 'Network access is turned off.',
    where: url,
    detail: `  ${cause}, so Rarn refused to make this request.`,
    how,
  })
}

export function isNetworkBlocked(error: unknown): boolean {
  return error instanceof RarnError && error.code === Code.NetworkBlocked
}
