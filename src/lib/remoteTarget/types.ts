import type tinyhand from 'tinyhand'

export type SshShell = 'cmd' | 'fish' | 'posix' | 'powershell'

export type RuntimeName = 'bun' | 'deno' | 'node'

export type ShellName = 'bash' | 'cmd' | 'fish' | 'powershell' | 'sh' | 'unknown' | 'zsh'

export type LinuxDistribution = 'arch' | 'debian' | 'nixos' | 'unknown'

export type OsInfo
  = | {distribution: LinuxDistribution
    name: 'linux'
    release?: string}
    | {name: 'unknown'
      release?: string}
    | {name: 'windows'
      release?: string}

export type ShellInfo = {file?: string
  name: ShellName}

export type ProcessFailure = 'output-limit' | 'protocol' | 'signal' | 'spawn' | 'stdin' | 'stream' | 'timeout'
export type InvocationControls = {signal?: AbortSignal
  timeoutMs?: number}

export type InvocationResult = {
  duration: number
  errorCode?: string
  exitCode: number
  failure?: ProcessFailure
  stderr?: string
  stdout?: string
  system: {pid: number}
}

export type TransportResult = InvocationResult & {protocol?: {error?: string
  json?: string}}

export type ExecResult = InvocationResult & {command: Array<string>}

export type RuntimeInfo = {file: string
  name: RuntimeName
  version?: string}

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
  initializationTimeoutMs: number
  keyFile?: string
  knownHostsFile?: string
  port?: number
  runtimeCandidates: Array<RuntimeName>
  sshConfigFile?: string
  sshOptions?: Array<string>
  sshShell?: SshShell
  strictHostKeyChecking?: 'accept-new' | 'yes'
  user?: string
}

export type RemoteTargetConstructorOptions = Omit<Partial<RemoteTargetOptions>, 'host'>
export type RemoteTargetInputOptions = {host: string} & Partial<RemoteTargetOptions>
export type RemoteTargetInput = tinyhand.Wrap<'host', RemoteTargetInputOptions>
export type RunInput = (() => unknown) | string

export type NormalizedRunInput = {
  exportsKey: string
  hasReturnValue: boolean
  inputCode: string
  normalizedCode: string
  returnValueKey: string
}

export type TransportCommandOptions = {
  /** Internal framed stdout capture. Ordinary transport callers receive unmodified stdout. */
  frame?: {
    marker: string
    maxBytes: number
    onError: (message: string) => void
    onFrame: (json: string) => void
  }
  maxOutputBytes?: number
  protocol?: {marker: string
    maxBytes: number}
  /** Treat an early stdin closure as failed delivery rather than an ordinary unused pipe. */
  requireStdinDelivery?: boolean
  signal?: AbortSignal
  stdin?: string
  timeoutMs?: number
}

export type InvocationOptions = Omit<TransportCommandOptions, 'frame' | 'protocol' | 'requireStdinDelivery'> & {
  /** Maximum JSON result size, separate from user stdout/stderr. Defaults to 16 million bytes. */
  maxResultBytes?: number
}
export type RunInvocationOptions = Omit<InvocationOptions, 'stdin'>
