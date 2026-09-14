import type {TargetTransport} from '../transport/base/TargetTransport.ts'
import type {DiscoveryInfo, LinuxDistribution, OsInfo, RuntimeInfo, RuntimeName, ShellInfo, ShellName} from './types.ts'

import {InvocationDeadline} from './InvocationDeadline.ts'
import {RemoteTargetError} from './RemoteTargetError.ts'
import {ResultFrame} from './ResultFrame.ts'
import {runProcess} from './runProcess.ts'

type DiscoverySections = {
  os?: boolean
  runtimes?: boolean
  shell?: boolean
}

// Embedded remotely; all runtime dependencies and helper state remain inside this function.
async function collectDiscovery(timeoutMs: number, run: typeof runProcess, runtimeNames: Array<RuntimeName>, sections: DiscoverySections = {}): Promise<Omit<DiscoveryInfo, 'bootstrapRuntime'>> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const {default: process} = await import('node:process')
  const deadline = performance.now() + timeoutMs
  const discoverOs = sections.os !== false
  const discoverRuntimes = sections.runtimes !== false
  const discoverShell = sections.shell !== false
  // These helpers must remain inside the function embedded on the target.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const normalizePath = (value: string) => value.replaceAll('\\', '/')
  const runtimes: Array<RuntimeInfo> = []
  if (discoverRuntimes) {
    let current: RuntimeName = 'node'
    if (typeof Bun === 'object') {
      current = 'bun'
    } else if (typeof (globalThis as {Deno?: unknown}).Deno === 'object') {
      current = 'deno'
    }
    const firstLine = (value: string | undefined) => value?.split(/\r?\n/u).find(line => line.trim())?.trim()
    const paths = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1]?.split(path.delimiter) ?? []
    const findExecutable = (name: string) => {
      if (name === current) {
        return process.execPath
      }
      const suffixes = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
      for (const directory of paths) {
        for (const suffix of suffixes) {
          const file = path.join(directory.replaceAll(/^"|"$/gu, ''), name + suffix)
          try {
            if (!fs.statSync(file).isFile()) {
              continue
            }
            fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
            return file
          } catch {}
        }
      }
    }
    for (const name of runtimeNames) {
      const file = findExecutable(name)
      if (!file) {
        continue
      }
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) {
        throw new Error('Discovery timed out.')
      }
      const result = await run([file, '--version'], {
        timeoutMs: Math.min(2000, remaining),
        maxOutputBytes: 64_000,
      })
      if (result.failure && !(result.failure === 'spawn' && result.errorCode === 'ENOENT')) {
        throw new Error(result.stderr ?? 'Runtime probe failed.')
      }
      if (result.exitCode !== 0) {
        continue
      }
      let version = firstLine(result.stdout)
      if (name === 'deno') {
        version = version?.startsWith('deno ') ? version.slice(5) : undefined
      }
      if (!version || !(name === 'node' ? /^v\d/u : /^\d/u).test(version)) {
        continue
      }
      runtimes.push({
        file: normalizePath(file),
        name,
        version,
      })
    }
  }
  let osInfo: OsInfo = {name: 'unknown'}
  if (discoverOs) {
    let distribution: LinuxDistribution = 'unknown'
    if (process.platform === 'linux') {
      try {
        const release: Record<string, string | undefined> = Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split(/\r?\n/u).flatMap(line => {
          const match = /^([A-Z_]+)=(.*)$/u.exec(line)
          if (!match) {
            return []
          }
          return [[match[1], match[2].replace(/^(["'])(.*)\1$/u, '$2')]]
        }))
        const ids = new Set([release.ID, ...release.ID_LIKE?.split(/\s+/u) ?? []])
        if (ids.has('nixos')) {
          distribution = 'nixos'
        } else if (ids.has('arch')) {
          distribution = 'arch'
        } else if (ids.has('debian') || ids.has('ubuntu')) {
          distribution = 'debian'
        }
      } catch {}
    }
    osInfo = process.platform === 'linux' ? {
      name: 'linux',
      distribution,
      release: os.release(),
    } : {
      name: process.platform === 'win32' ? 'windows' : 'unknown',
      release: os.release(),
    }
  }
  let shell: ShellInfo = {name: 'unknown'}
  if (discoverShell) {
    const shellFile = process.platform === 'win32' ? process.env.ComSpec : process.env.SHELL
    const basename = path.basename(shellFile ?? '').toLowerCase().replace(/\.exe$/u, '')
    let shellName: ShellName = 'unknown'
    if (basename === 'pwsh' || basename === 'powershell') {
      shellName = 'powershell'
    } else if (basename === 'cmd' || basename === 'fish' || basename === 'sh' || basename === 'bash' || basename === 'zsh') {
      shellName = basename
    }
    shell = {
      name: shellName,
      ...shellFile ? {file: normalizePath(shellFile)} : {},
    }
  }
  return {
    os: osInfo,
    runtimes,
    shell,
  }
}

export const getRuntimeCommand = (runtime: RuntimeInfo | RuntimeName) => {
  const name = typeof runtime === 'string' ? runtime : runtime.name
  const file = typeof runtime === 'string' ? runtime : runtime.file
  if (name === 'bun') {
    return [file, '-']
  }
  if (name === 'deno') {
    return [file, 'run', '-A', '-']
  }
  return [file, '--input-type=module', '-']
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isDiscoveryInfo = (value: {os?: unknown
  runtimes?: unknown
  shell?: unknown}): value is Omit<DiscoveryInfo, 'bootstrapRuntime'> => {
  if (!isRecord(value.os) || !isRecord(value.shell) || !Array.isArray(value.runtimes)) {
    return false
  }
  const {os, shell, runtimes} = value
  if (!['linux', 'windows', 'unknown'].includes(String(os.name)) || os.release !== undefined && typeof os.release !== 'string') {
    return false
  }
  if (os.name === 'linux' && !['arch', 'debian', 'nixos', 'unknown'].includes(String(os.distribution))) {
    return false
  }
  if (!['bash', 'cmd', 'fish', 'powershell', 'sh', 'unknown', 'zsh'].includes(String(shell.name)) || shell.file !== undefined && typeof shell.file !== 'string') {
    return false
  }
  return runtimes.every((runtime: unknown) => isRecord(runtime) && typeof runtime.file === 'string' && ['bun', 'node', 'deno'].includes(String(runtime.name)) && (runtime.version === undefined || typeof runtime.version === 'string'))
}

export const discoverTarget = async (transport: TargetTransport, bootstrapRuntime: RuntimeInfo, runtimeNames: Array<RuntimeName> = ['bun', 'node', 'deno'], deadline = new InvocationDeadline({timeoutMs: 30_000}), sections: DiscoverySections = {}): Promise<DiscoveryInfo> => {
  const frame = new ResultFrame(65_536)
  const result = await transport.runShellNeutralCommand(getRuntimeCommand(bootstrapRuntime), {
    ...deadline.options(),
    frame: frame.options(),
    maxOutputBytes: 65_536,
    requireStdinDelivery: true,
    stdin: `const run = ${runProcess.toString()}
const collect = ${collectDiscovery.toString()}
console.log(${JSON.stringify(frame.marker)} + JSON.stringify({ok: true, ...await collect(${deadline.remaining() ?? 30_000}, run, ${JSON.stringify(runtimeNames)}, ${JSON.stringify(sections)})}))`,
  })
  const raw = frame.read<{ok: boolean
    os?: unknown
    runtimes?: unknown
    shell?: unknown}>(result, `Failed to discover target details using ${bootstrapRuntime.name}.`)
  if (!isDiscoveryInfo(raw)) {
    throw new RemoteTargetError('Invalid discovery payload.', result)
  }
  const runtimes = raw.runtimes
  return {
    bootstrapRuntime: runtimes.find(runtime => runtime.name === bootstrapRuntime.name) ?? bootstrapRuntime,
    os: raw.os,
    runtimes,
    shell: transport.getShell() ?? raw.shell,
  }
}

const probe = async (transport: TargetTransport, command: Array<string>, deadline: InvocationDeadline) => {
  const result = await transport.runShellNeutralCommand(command, {
    ...deadline.options(),
    maxOutputBytes: 65_536,
  })
  if (result.failure && !(result.failure === 'spawn' && result.errorCode === 'ENOENT') || result.exitCode === 255 || result.exitCode === 124) {
    throw new RemoteTargetError('Transport failed during runtime discovery.', result)
  }
  return result
}

export const discoverWithoutRuntime = async (transport: TargetTransport, deadline = new InvocationDeadline({timeoutMs: 30_000}), sections: Pick<DiscoverySections, 'os' | 'shell'> = {}): Promise<DiscoveryInfo> => {
  const shell = sections.shell === false ? undefined : transport.getShell()
  if (sections.os === false) {
    return {
      os: {name: 'unknown'},
      runtimes: [],
      shell: shell ?? {name: 'unknown'},
    }
  }
  const linux = await probe(transport, ['uname', '-s'], deadline)
  if (linux.exitCode === 0 && linux.stdout?.trim().toLowerCase() === 'linux') {
    return {
      os: {
        name: 'linux',
        distribution: 'unknown',
      },
      runtimes: [],
      shell: shell ?? {name: 'unknown'},
    }
  }
  if (shell?.name === 'powershell' || shell?.name === 'cmd') {
    return {
      os: {name: 'windows'},
      runtimes: [],
      shell,
    }
  }
  return {
    os: {name: 'unknown'},
    runtimes: [],
    shell: shell ?? {name: 'unknown'},
  }
}

export const probeBootstrapRuntime = async (transport: TargetTransport, runtimeNames: Array<RuntimeName> = ['bun', 'node', 'deno'], deadline = new InvocationDeadline({timeoutMs: 30_000}), sections: DiscoverySections = {}): Promise<DiscoveryInfo | undefined> => {
  for (const name of runtimeNames) {
    const version = await probe(transport, [name, '--version'], deadline)
    if (version.exitCode !== 0) {
      continue
    }
    const runtime: RuntimeInfo = {
      file: name,
      name,
      version: name === 'deno' ? version.stdout?.trim().split(/\r?\n/u)[0]?.replace(/^deno /u, '') : version.stdout?.trim().split(/\r?\n/u)[0],
    }
    // A runtime that starts but cannot execute discovery is not an absent runtime.
    return discoverTarget(transport, runtime, runtimeNames, deadline, sections)
  }
}
