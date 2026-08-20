import chalk from 'chalk'
import {
  awaitDeviceToken,
  githubLogin,
  readToken,
  startDeviceFlow,
  writeToken,
} from '../../publish/auth.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'
import { createProgress } from '../progress.ts'

/**
 * The OAuth app the default index nominates.
 *
 * Read from the index's `config.json` in principle; hardcoded as the fallback so a
 * login still works when the index cannot be reached, which is exactly the moment a
 * network problem would otherwise look like an auth problem.
 */
export const DEFAULT_GITHUB_CLIENT_ID = '7bd503594a0f9a9f7ed3'

export interface LoginOptions {
  cwd: string
  clientId?: string
  force?: boolean
}

export async function login(
  options: LoginOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const apiUrl = await registry.apiBase()

  const existing = await readToken(apiUrl)
  if (existing !== undefined && options.force !== true) {
    const who = await githubLogin(existing)
    const as = who === undefined ? '' : ` as ${chalk.bold(who)}`
    process.stdout.write(
      [
        `${chalk.green('already logged in')} to ${chalk.cyan(apiUrl)}${as}`,
        chalk.dim('  use `rarn login --force` to sign in as someone else'),
        '',
      ].join('\n'),
    )
    return
  }

  const clientId = options.clientId ?? DEFAULT_GITHUB_CLIENT_ID
  const grant = await startDeviceFlow(clientId)

  // Printed before the spinner starts, and left on screen. The code is the one
  // thing the user has to read and retype, so it must not be on a line that a
  // spinner will later erase.
  process.stdout.write(
    [
      '',
      `  Open ${chalk.cyan(grant.verificationUri)}`,
      `  and enter the code  ${chalk.bold(chalk.yellow(grant.userCode))}`,
      '',
    ].join('\n'),
  )

  const progress = createProgress()
  progress.stage('waiting for the browser')
  try {
    const token = await awaitDeviceToken(clientId, grant)
    progress.stop()

    await writeToken(apiUrl, token)
    const who = await githubLogin(token)
    process.stdout.write(
      `${chalk.green('logged in')} to ${chalk.cyan(apiUrl)}${who === undefined ? '' : ` as ${chalk.bold(who)}`}\n`,
    )
  } catch (error) {
    progress.fail()
    throw error
  }
}
