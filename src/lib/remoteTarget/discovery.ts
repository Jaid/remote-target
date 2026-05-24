import type {TargetTransport} from './base/TargetTransport.ts'
import type {DiscoveryInfo, LinuxDistribution, OsInfo, RuntimeInfo, RuntimeName, ShellInfo, ShellName} from './types.ts'

import {toJavaScriptLiteral} from './toJavaScriptLiteral.ts'

const runtimeVersionArguments: Record<RuntimeName, Array<string>> = {
  bun: ['--version'],
  deno: ['--version'],
  node: ['--version'],
}
const isLinuxDistribution = (value: string): value is LinuxDistribution => {
  return value === 'arch' || value === 'debian' || value === 'nixos' || value === 'unknown'
}
const isRuntimeName = (value: string): value is RuntimeName => {
  return value === 'bun' || value === 'deno' || value === 'node'
}
const isShellName = (value: string): value is ShellName => {
  return value === 'bash' || value === 'fish' || value === 'powershell' || value === 'unknown' || value === 'zsh'
}
const getFirstLine = (value: string | undefined) => {
  return value?.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim()
}
const normalizeRuntimeVersion = (runtimeName: RuntimeName, value: string | undefined) => {
  const firstLine = getFirstLine(value)
  if (!firstLine) {
    return
  }
  if (runtimeName === 'deno' && firstLine.startsWith('deno ')) {
    return firstLine.slice('deno '.length)
  }
  return firstLine
}
const normalizeOsInfo = (value: unknown): OsInfo => {
  if (!value || typeof value !== 'object') {
    return {
      name: 'unknown',
    }
  }
  const candidate = value as Record<string, unknown>
  const release = typeof candidate.release === 'string' && candidate.release.trim().length > 0 ? candidate.release : undefined
  if (candidate.name === 'linux') {
    return {
      distribution: typeof candidate.distribution === 'string' && isLinuxDistribution(candidate.distribution) ? candidate.distribution : 'unknown',
      name: 'linux',
      ...release ? {release} : {},
    }
  }
  if (candidate.name === 'windows') {
    return {
      name: 'windows',
      ...release ? {release} : {},
    }
  }
  return {
    name: 'unknown',
    ...release ? {release} : {},
  }
}
const normalizeRuntimeInfo = (value: unknown): RuntimeInfo | undefined => {
  if (!value || typeof value !== 'object') {
    return
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.file !== 'string' || typeof candidate.name !== 'string' || !isRuntimeName(candidate.name)) {
    return
  }
  return {
    file: candidate.file,
    name: candidate.name,
    ...typeof candidate.version === 'string' && candidate.version.trim().length > 0 ? {version: candidate.version} : {},
  }
}
const normalizeShellInfo = (value: unknown): ShellInfo => {
  if (!value || typeof value !== 'object') {
    return {
      name: 'unknown',
    }
  }
  const candidate = value as Record<string, unknown>
  return {
    ...typeof candidate.file === 'string' && candidate.file.trim().length > 0 ? {file: candidate.file} : {},
    name: typeof candidate.name === 'string' && isShellName(candidate.name) ? candidate.name : 'unknown',
  }
}
const normalizeRuntimeList = (value: unknown) => {
  return Array.isArray(value) ? value.map(item => normalizeRuntimeInfo(item)).filter((item): item is RuntimeInfo => item !== undefined) : []
}
const emptyDiscoveryInfo = (): DiscoveryInfo => {
  return {
    os: {
      name: 'unknown',
    },
    runtimes: [],
    shell: {
      name: 'unknown',
    },
  }
}
const discoveryScript = (runtimeCandidates: Array<RuntimeName>) => String.raw`
import {readFileSync} from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import {spawnSync} from 'node:child_process'

const runtimeCandidates = ${toJavaScriptLiteral(runtimeCandidates)}
const currentRuntimeName = typeof Bun === 'object'
  ? 'bun'
  : typeof Deno === 'object'
    ? 'deno'
    : 'node'
const normalizePath = value => String(value).replaceAll('\\', '/')
const run = (command, args = []) => {
  try {
    const result = spawnSync(command, args, {encoding: 'utf8'})
    return {
      exitCode: result.status ?? 1,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    }
  } catch (error) {
    return {
      exitCode: 1,
      stderr: String(error),
      stdout: '',
    }
  }
}
const getFirstLine = value => value.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim()
const getShellName = value => {
  const basename = normalizePath(value).split('/').at(-1)?.toLowerCase() ?? ''
  if (basename.includes('pwsh') || basename.includes('powershell')) {
    return 'powershell'
  }
  if (basename.includes('fish')) {
    return 'fish'
  }
  if (basename.includes('zsh')) {
    return 'zsh'
  }
  if (basename.includes('bash') || basename.includes('sh')) {
    return 'bash'
  }
  return 'unknown'
}
const getLinuxDistribution = () => {
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf8')
    if (/\bID=nixos\b/u.test(osRelease)) {
      return 'nixos'
    }
    if (/\bID=arch\b/u.test(osRelease) || /\bID_LIKE=.*\barch\b/u.test(osRelease)) {
      return 'arch'
    }
    if (/\bID=ubuntu\b/u.test(osRelease) || /\bID=debian\b/u.test(osRelease) || /\bID_LIKE=.*\bdebian\b/u.test(osRelease)) {
      return 'debian'
    }
  } catch {}
  return 'unknown'
}
const findExecutable = name => {
  if (name === currentRuntimeName && typeof process.execPath === 'string' && process.execPath.length > 0) {
    return normalizePath(process.execPath)
  }
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = run(command, [name])
  if (result.exitCode === 0) {
    const firstLine = getFirstLine(result.stdout)
    if (firstLine) {
      return normalizePath(firstLine)
    }
  }
  const versionResult = run(name, ['--version'])
  if (versionResult.exitCode === 0) {
    return name
  }
}
const getRuntimeVersion = name => {
  const result = run(name, ['--version'])
  if (result.exitCode !== 0) {
    return undefined
  }
  const firstLine = getFirstLine(result.stdout)
  if (!firstLine) {
    return undefined
  }
  return name === 'deno' && firstLine.startsWith('deno ') ? firstLine.slice('deno '.length) : firstLine
}
const shellFile = process.platform === 'win32'
  ? findExecutable('pwsh.exe') || findExecutable('powershell.exe') || process.env.ComSpec || ''
  : process.env.SHELL || getFirstLine(run('ps', ['-p', String(process.ppid), '-o', 'comm=']).stdout) || ''
const shell = {
  ...(shellFile ? {file: normalizePath(shellFile)} : {}),
  name: process.platform === 'win32' && process.env.PSModulePath ? 'powershell' : getShellName(shellFile),
}
const osInfo = process.platform === 'linux'
  ? {distribution: getLinuxDistribution(), name: 'linux', release: os.release()}
  : process.platform === 'win32'
    ? {name: 'windows', release: os.release()}
    : {name: 'unknown', release: os.release()}
const runtimes = runtimeCandidates.flatMap(name => {
  const file = findExecutable(name)
  if (!file) {
    return []
  }
  return [{file, name, version: getRuntimeVersion(name)}]
})
console.log(JSON.stringify({os: osInfo, runtimes, shell}))
`

export const getRuntimeCommand = (runtimeName: RuntimeName) => {
  if (runtimeName === 'bun') {
    return ['bun', '-']
  }
  if (runtimeName === 'deno') {
    return ['deno', 'run', '-A', '-']
  }
  return ['node', '--input-type=module', '-']
}

export const discoverTarget = async (transport: TargetTransport, bootstrapRuntime: RuntimeInfo): Promise<DiscoveryInfo> => {
  const result = await transport.runShellNeutralCommand(getRuntimeCommand(bootstrapRuntime.name), {
    stdin: discoveryScript(['bun', 'node', 'deno']),
  })
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(`Failed to discover target details using ${bootstrapRuntime.name}.`)
  }
  const rawResult = JSON.parse(result.stdout) as {
    os?: unknown
    runtimes?: unknown
    shell?: unknown
  }
  return {
    bootstrapRuntime,
    os: normalizeOsInfo(rawResult.os),
    runtimes: normalizeRuntimeList(rawResult.runtimes),
    shell: normalizeShellInfo(rawResult.shell),
  }
}

export const discoverWithoutRuntime = async (transport: TargetTransport): Promise<DiscoveryInfo> => {
  const linuxProbe = await transport.runShellNeutralCommand(['uname', '-s']).catch(() => {})
  if (linuxProbe?.exitCode === 0 && linuxProbe.stdout?.trim().toLowerCase() === 'linux') {
    const envProbe = await transport.runShellNeutralCommand(['env']).catch(() => {})
    const shellLine = envProbe?.stdout?.split(/\r?\n/u).find(line => line.startsWith('SHELL='))
    const shellFile = shellLine?.slice('SHELL='.length)
    let shellName: ShellName = 'unknown'
    if (shellFile?.includes('fish')) {
      shellName = 'fish'
    } else if (shellFile?.includes('zsh')) {
      shellName = 'zsh'
    } else if (shellFile?.includes('bash')) {
      shellName = 'bash'
    }
    return {
      os: {
        distribution: 'unknown',
        name: 'linux',
      },
      runtimes: [],
      shell: {
        ...shellFile ? {file: shellFile} : {},
        name: shellName,
      },
    }
  }
  const powershellProbe = await transport.runShellNeutralCommand(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']).catch(() => {})
  if (powershellProbe?.exitCode === 0) {
    return {
      os: {
        name: 'windows',
      },
      runtimes: [],
      shell: {
        name: 'powershell',
      },
    }
  }
  return emptyDiscoveryInfo()
}

export const probeBootstrapRuntime = async (transport: TargetTransport, runtimeNames: Array<RuntimeName> = ['bun', 'node', 'deno']) => {
  for (const runtimeName of runtimeNames) {
    const versionProbe = await transport.runShellNeutralCommand([runtimeName, ...runtimeVersionArguments[runtimeName]]).catch(() => {})
    if (versionProbe?.exitCode !== 0) {
      continue
    }
    const runtimeInfo = {
      file: runtimeName,
      name: runtimeName,
      ...normalizeRuntimeVersion(runtimeName, versionProbe.stdout) ? {version: normalizeRuntimeVersion(runtimeName, versionProbe.stdout)} : {},
    } satisfies RuntimeInfo
    try {
      await discoverTarget(transport, runtimeInfo)
      return runtimeInfo
    } catch {}
  }
}
