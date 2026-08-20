import chalk from 'chalk'
import { authFilePath, clearToken } from '../../publish/auth.ts'
import { createRegistryClient } from '../../registry/client.ts'
import type { RegistryClient } from '../../registry/types.ts'

export interface LogoutOptions {
  cwd: string
}

export async function logout(
  _options: LogoutOptions,
  registry: RegistryClient = createRegistryClient(),
): Promise<void> {
  const apiUrl = await registry.apiBase()
  const removed = await clearToken(apiUrl)

  // Not an error. `logout` asks for a state, and that state already holds — failing
  // here would make the command unusable in any script that just wants to be sure.
  if (!removed) {
    process.stdout.write(`${chalk.dim('not logged in to')} ${apiUrl}\n`)
    return
  }

  process.stdout.write(
    [
      `${chalk.green('logged out')} of ${chalk.cyan(apiUrl)}`,
      chalk.dim(`  token removed from ${authFilePath()}`),
      '',
    ].join('\n'),
  )
}
