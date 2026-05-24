export type RuntimeName = 'bun' | 'deno' | 'node'

export type ShellName = 'bash' | 'fish' | 'powershell' | 'unknown' | 'zsh'

export type LinuxDistribution = 'arch' | 'debian' | 'nixos' | 'unknown'

export type OsInfo
  = | {
    distribution: LinuxDistribution
    name: 'linux'
    release?: string
  }
  | {
    name: 'unknown'
    release?: string
  }
  | {
    name: 'windows'
    release?: string
  }

export type ShellInfo = {
  file?: string
  name: ShellName
}

export type InvocationResult = {
  duration: number
  exitCode: number
  stderr?: string
  stdout?: string
  system: {
    maxRss?: number
    pid: number
  }
}

export type ExecResult = InvocationResult & {
  command: Array<string>
}

export type RuntimeInfo = {
  file: string
  name: RuntimeName
  version?: string
}

export type DiscoveryInfo = {
  bootstrapRuntime?: RuntimeInfo
  os: OsInfo
  runtimes: Array<RuntimeInfo>
  shell: ShellInfo
}

export type RunResult = InvocationResult & {
  exports?: Record<string, unknown>
  inputCode: string
  normalizedCode: string
  returnValue?: unknown
  runtime: RuntimeInfo
}

export type RemoteTargetOptions = {
  globals: Record<string, unknown>
  host: string
  keyFile?: string
  port?: number
  runtimeCandidates: Array<RuntimeName>
  user?: string
}

export type RemoteTargetConstructorOptions = Omit<Partial<RemoteTargetOptions>, 'host'>

export type RemoteTargetInputOptions = {host: string} & Partial<RemoteTargetOptions>

export type RemoteTargetInput = RemoteTargetInputOptions | string

export type RunInput = (() => unknown) | string

export type NormalizedRunInput = {
  hasReturnValue: boolean
  inputCode: string
  normalizedCode: string
  returnValueKey: string
}

export type TransportCommandOptions = {
  stdin?: string
}
