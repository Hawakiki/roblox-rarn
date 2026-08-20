import chalk from 'chalk'
import { authFilePath, githubLogin, readToken } from '../../publish/auth.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { Code } from '../../util/codes.ts'
import { RarnError } from '../../util/errors.ts'
import { writeJson } from '../project.ts'

export interface WhoamiOptions {
  cwd: string
  json?: boolean
}

/**
 * Who the stored token belongs to.
 *
 * Asks GitHub rather than reporting the name that was saved at login, because a
 * token can be revoked at any time and a cached name would keep claiming a login
 * that no longer works — the failure would surface at `publish` instead, which is
 * the worst possible moment to discover it.
 */
export async function whoami(
  options: WhoamiOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const apiUrl = await registry.apiBase()
  const token = await readToken(apiUrl)

  if (token === undefined) {
    throw new RarnError({
      code: Code.NotLoggedIn,
      what: `not logged in to ${apiUrl}.`,
      how: 'Run `rarn login`.',
    })
  }

  const who = await githubLogin(token)
  if (who === undefined) {
    throw new RarnError({
      code: Code.NotLoggedIn,
      what: 'the stored token is no longer valid.',
      where: authFilePath(),
      how: 'Run `rarn login` to sign in again.',
    })
  }

  if (options.json === true) {
    writeJson({ registry: apiUrl, user: who })
    return
  }

  process.stdout.write(`${chalk.bold(who)} ${chalk.dim(`on ${apiUrl}`)}\n`)
}
