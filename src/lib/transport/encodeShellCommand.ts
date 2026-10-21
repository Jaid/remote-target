import type {SshShell} from '../remoteTarget/types.ts'

import {gzipSync} from 'node:zlib'

import createEscaper, {escapePowershell} from 'escapers'

import {buildDesktopRelay} from './desktopRelay.ts'

export const escapePosix = createEscaper(value => `'${value.replaceAll("'", "'\"'\"'")}'`, items => items.join(' '))
const escapeFishCodePoint = (value: string) => {
  const codePoint = value.codePointAt(0)
  if (codePoint === undefined) {
    return ''
  }
  if (codePoint <= 0x7F) {
    return String.raw`\x${codePoint.toString(16).padStart(2, '0')}`
  }
  if (codePoint <= 0xFF_FF) {
    return String.raw`\u${codePoint.toString(16).padStart(4, '0')}`
  }
  return String.raw`\U${codePoint.toString(16).padStart(8, '0')}`
}
// Fish accepts unquoted escape sequences as one word. Encoding every code point avoids quote/backslash interactions across OpenSSH's command hop.
export const escapeFish = createEscaper(value => {
  if (value.includes('\0')) {
    throw new TypeError('Fish arguments cannot contain NUL.')
  }
  return value.length === 0 ? "''" : [...value].map(escapeFishCodePoint).join('')
}, items => items.join(' '))

export type EncodeShellCommandOptions = {
  /** On Windows, run the command in the SSH user's interactive desktop session if the SSH session itself is not interactive. */
  desktopSession?: boolean
}

export const encodeShellCommand = (command: Array<string>, shell: SshShell, options: EncodeShellCommandOptions = {}) => {
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
  const direct = `& ${command.map(argument => escapePowershell(argument)).join(' ')}; exit $LASTEXITCODE`
  const powershell = `$ErrorActionPreference = 'Stop'; if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3 or newer is required for native argv preservation.' }; $PSNativeCommandArgumentPassing = 'Standard'; [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${options.desktopSession ? buildDesktopRelay(command, direct) : direct}`
  if (shell === 'powershell') {
    return powershell
  }
  // Only fixed ASCII syntax and base64 cross cmd.exe; argv are interpreted by modern PowerShell.
  if (options.desktopSession) {
    // The relay does not fit cmd.exe's 8191-character command line as UTF-16 base64, so it travels gzipped instead.
    const compressed = gzipSync(powershell, {level: 9}).toString('base64')
    return `pwsh.exe -NoLogo -NoProfile -NonInteractive -Command Invoke-Expression ([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}')), [IO.Compression.CompressionMode]::Decompress)).ReadToEnd())`
  }
  return `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershell, 'utf16le').toString('base64')}`
}
