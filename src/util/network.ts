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
  const value = env[NO_NETWORK_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

/**
 * Not a `RegistryError`, so this exits 1 rather than 2.
 *
 * Exit 2 means "the network failed, retrying might help". Nothing failed here and
 * retrying will produce exactly this again — the machine was told not to go out.
 * A CI job that retries on 2 would otherwise loop on a decision it made itself.
 */
export function networkBlockedError(url: string): RarnError {
  return new RarnError({
    code: Code.NetworkBlocked,
    what: 'Network access is turned off.',
    where: url,
    detail: `  ${NO_NETWORK_ENV} is set, so Rarn refused to make this request.`,
    how: `Unset ${NO_NETWORK_ENV} to allow it. If this is CI, the code under test tried to reach the network — give it a fetch stand-in instead.`,
  })
}

export function isNetworkBlocked(error: unknown): boolean {
  return error instanceof RarnError && error.code === Code.NetworkBlocked
}
