import type {SshShell} from '../remoteTarget/types.ts'

import createEscaper, {escapePowershell} from 'escapers'

export const escapePosix = createEscaper(value => `'${value.replaceAll("'", "'\"'\"'")}'`, items => items.join(' '))
// Unlike POSIX single quotes, fish single quotes interpret escaped backslashes and apostrophes.
export const escapeFish = createEscaper(value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`)}'`, items => items.join(' '))

export const encodeShellCommand = (command: Array<string>, shell: SshShell) => {
  if (!command[0]) {
    throw new Error('Cannot run an empty command.')
  }
  if (command.some(argument => argument.includes('\0'))) {
    throw new TypeError('Shell arguments cannot contain NUL.')
  }
  if (shell === 'posix' || shell === 'fish') {
    const escape = shell === 'fish' ? escapeFish : escapePosix
    return `exec ${command.map(argument => escape(argument)).join(' ')}`
  }
  const powershell = `$ErrorActionPreference = 'Stop'; if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3 or newer is required for native argv preservation.' }; $PSNativeCommandArgumentPassing = 'Standard'; [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ${command.map(argument => escapePowershell(argument)).join(' ')}; exit $LASTEXITCODE`
  if (shell === 'powershell') {
    return powershell
  }
  // Only fixed ASCII syntax and base64 cross cmd.exe; argv are interpreted by modern PowerShell.
  return `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershell, 'utf16le').toString('base64')}`
}
