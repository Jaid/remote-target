import type {DiscoveryInfo, ExecResult, InvocationOptions, RemoteTargetConstructorOptions, RemoteTargetInput, RemoteTargetOptions, RunInput, RunInvocationOptions, RunResult, RuntimeInfo, RuntimeName, SshShell} from './lib/remoteTarget/types.ts'

import {enforceForwardSlashes} from 'forward-slash-path'
import optis from 'optis'
import tinyhand from 'tinyhand'

import {discoverWithoutRuntime, getRuntimeCommand, probeBootstrapRuntime} from './lib/remoteTarget/discovery.ts'
import {InvocationDeadline, InvocationTimeoutError} from './lib/remoteTarget/InvocationDeadline.ts'
import {normalizeRunInput} from './lib/remoteTarget/normalize.ts'
import {RemoteTargetError} from './lib/remoteTarget/RemoteTargetError.ts'
import {isInvocationResult, ResultFrame} from './lib/remoteTarget/ResultFrame.ts'
import {deserializeTransportValue} from './lib/remoteTarget/serialize.ts'
import {buildExecWrapper, buildRunWrapper} from './lib/remoteTarget/wrappers.ts'
import {TargetTransport} from './lib/transport/base/TargetTransport.ts'
import {LocalTargetTransport} from './lib/transport/LocalTargetTransport.ts'
import {SshTargetTransport} from './lib/transport/SshTargetTransport.ts'

const supportedRuntimeNames = ['bun', 'node', 'deno'] as const satisfies Array<RuntimeName>

type RunPayload = {error?: unknown
  exports?: unknown
  ok: boolean
  returnValue?: unknown}
type ExecPayload = {error?: unknown
  ok: boolean
  result?: unknown}

const normalizeRuntimeCandidates = (value: Array<RuntimeName> | undefined) => {
  const candidates = [...new Set(value ?? supportedRuntimeNames)]
  const invalid = candidates.find(candidate => !supportedRuntimeNames.includes(candidate))
  if (invalid) {
    throw new Error(`Unsupported runtime candidate: ${String(invalid)}`)
  }
  return candidates.length === 0 ? [...supportedRuntimeNames] : candidates
}
const getExecCommandTimeout = (remaining: number | undefined) => {
  if (remaining === undefined) {
    return
  }
  const resultFlushReserve = Math.min(100, Math.max(1, Math.floor(remaining / 2)))
  return Math.max(1, remaining - resultFlushReserve)
}
const optionsSchema = optis({
  defaults: {
    globals: {},
    initializationTimeoutMs: 30_000,
    runtimeCandidates: [...supportedRuntimeNames] as Array<RuntimeName>,
  },
  normalizations: {
    globals: (value: Record<string, unknown> | undefined) => ({...value}),
    host: (value: string) => value.trim(),
    keyFile: (value: string | undefined) => {
      return value ? enforceForwardSlashes(value) : undefined
    },
    knownHostsFile: (value: string | undefined) => {
      return value ? enforceForwardSlashes(value) : undefined
    },
    port: (value: number | string | undefined) => {
      return value === undefined ? undefined : Number(value)
    },
    runtimeCandidates: normalizeRuntimeCandidates,
    user: (value: string | undefined) => value?.trim() || undefined,
  },
  optional: {
    keyFile: undefined as string | undefined,
    knownHostsFile: undefined as string | undefined,
    port: undefined as number | undefined,
    sshConfigFile: undefined as string | undefined,
    sshOptions: undefined as Array<string> | undefined,
    sshShell: undefined as SshShell | undefined,
    strictHostKeyChecking: undefined as 'accept-new' | 'yes' | undefined,
    transport: undefined as TargetTransport | undefined,
    user: undefined as string | undefined,
  },
  required: {host: ''},
})
class RemoteTarget {
  static exec(target: RemoteTargetInput, command: Array<string>, options?: RemoteTargetConstructorOptions, invocationOptions?: InvocationOptions) {
    return new RemoteTarget(target, options).exec(command, invocationOptions)
  }

  static run(target: RemoteTargetInput, input: RunInput, options?: RemoteTargetConstructorOptions, invocationOptions?: RunInvocationOptions) {
    return new RemoteTarget(target, options).run(input, invocationOptions)
  }

  readonly options: RemoteTargetOptions
  readonly transport: TargetTransport
  #discovery?: DiscoveryInfo
  #initializationPromise?: Promise<this>
  #runtime?: RuntimeInfo

  constructor(input: RemoteTargetInput, extraOptions: RemoteTargetConstructorOptions = {}) {
    this.options = optionsSchema.process({
      ...tinyhand('host', input),
      ...extraOptions,
    })
    if (this.options.host.length === 0) {
      throw new Error('Expected a non-empty host.')
    }
    if (!Number.isSafeInteger(this.options.initializationTimeoutMs) || this.options.initializationTimeoutMs < 1) {
      throw new RangeError('initializationTimeoutMs must be a positive safe integer.')
    }
    this.transport = this.options.transport ?? (this.options.host === 'local' ? new LocalTargetTransport : new SshTargetTransport(this.options))
  }

  async exec(command: Array<string>, invocationOptions: InvocationOptions = {}): Promise<ExecResult> {
    if (!command[0]) {
      throw new TypeError('Cannot execute an empty command.')
    }
    const deadlineOwner = {}
    try {
      const deadline = new InvocationDeadline(invocationOptions, deadlineOwner)
      if (this.options.host === 'local') {
        const result = await this.transport.runShellNeutralCommand(command, {
          ...invocationOptions,
          ...deadline.options(),
        })
        return {
          ...result,
          command,
          duration: deadline.elapsed,
        }
      }
      const frame = new ResultFrame(invocationOptions.maxResultBytes)
      await deadline.wait(this.init())
      const runtime = this.#discovery?.bootstrapRuntime
      if (!runtime) {
        const result = await this.transport.runShellNeutralCommand(command, {
          ...invocationOptions,
          ...deadline.options(),
        })
        return {
          ...result,
          command,
          duration: deadline.elapsed,
        }
      }
      const wrapper = buildExecWrapper(command, frame.marker, {
        ...invocationOptions,
        timeoutMs: getExecCommandTimeout(deadline.remaining()),
      })
      const invocation = await this.transport.runShellNeutralCommand(getRuntimeCommand(runtime), {
        ...deadline.options(),
        frame: frame.options(),
        maxOutputBytes: invocationOptions.maxOutputBytes,
        onStderrChunk: invocationOptions.onStderrChunk,
        onStdoutChunk: invocationOptions.onStdoutChunk,
        requireStdinDelivery: true,
        stdin: wrapper,
      })
      invocation.duration = deadline.elapsed
      if (invocation.exitCode === 124) {
        return {
          ...invocation,
          command,
        }
      }
      const payload = frame.read<ExecPayload>(invocation, `Remote command execution failed on ${this.options.host}.`)
      if (!isInvocationResult(payload.result)) {
        throw new RemoteTargetError('Invalid exec() result envelope.', invocation)
      }
      return {
        ...payload.result,
        command,
        duration: deadline.elapsed,
      }
    } catch (error) {
      invocationOptions.signal?.throwIfAborted()
      if (error instanceof InvocationTimeoutError && error.owner === deadlineOwner) {
        return {
          ...error.result,
          command,
        }
      }
      throw error
    }
  }

  getDiscovery() {
    if (!this.#discovery) {
      throw new Error('Target has not been initialized yet. Call init() first.')
    }
    return this.#discovery
  }

  getRuntime() {
    if (!this.#runtime) {
      throw new Error('Runtime has not been resolved yet. Call init() or run() first.')
    }
    return this.#runtime
  }

  async init(options: Pick<InvocationOptions, 'signal' | 'timeoutMs'> = {}) {
    const deadline = new InvocationDeadline(options)
    this.#initializationPromise ??= (async () => {
      try {
        return await this.initialize()
      } catch (error) {
        this.#initializationPromise = undefined
        throw error
      }
    })()
    return deadline.wait(this.#initializationPromise)
  }

  async run(input: RunInput, invocationOptions: RunInvocationOptions = {}): Promise<RunResult> {
    const deadline = new InvocationDeadline(invocationOptions)
    const frame = new ResultFrame(invocationOptions.maxResultBytes)
    await deadline.wait(this.init())
    const runtime = this.#runtime
    if (!runtime) {
      const available = this.#discovery?.runtimes.map(item => item.name).join(', ') || 'none'
      throw new Error(`No compatible runtime found on ${this.options.host}. Requested candidates: ${this.options.runtimeCandidates.join(', ')}. Available runtimes: ${available}.`)
    }
    const normalized = await deadline.wait(normalizeRunInput(input))
    const wrapper = buildRunWrapper(normalized.normalizedCode, this.options.globals, frame.marker, normalized.exportsKey, normalized.returnValueKey, runtime.name)
    const invocation = await this.transport.runShellNeutralCommand(getRuntimeCommand(runtime), {
      ...deadline.options(),
      frame: frame.options(),
      maxOutputBytes: invocationOptions.maxOutputBytes,
      onStderrChunk: invocationOptions.onStderrChunk,
      onStdoutChunk: invocationOptions.onStdoutChunk,
      requireStdinDelivery: true,
      stdin: wrapper,
    })
    invocation.duration = deadline.elapsed
    const payload = frame.read<RunPayload>(invocation, `Remote script execution failed on ${this.options.host}.`)
    try {
      return {
        ...invocation,
        exports: deserializeTransportValue(payload.exports) as Record<string, unknown> | undefined,
        inputCode: normalized.inputCode,
        normalizedCode: normalized.normalizedCode,
        returnValue: normalized.hasReturnValue ? deserializeTransportValue(payload.returnValue) : undefined,
        runtime,
      }
    } catch (error) {
      throw new RemoteTargetError('Invalid run() value encoding.', invocation, {cause: error})
    }
  }

  private async initialize() {
    const deadline = new InvocationDeadline({timeoutMs: this.options.initializationTimeoutMs})
    const discovery = await deadline.wait(probeBootstrapRuntime(this.transport, [...supportedRuntimeNames], deadline)) ?? await deadline.wait(discoverWithoutRuntime(this.transport, deadline))
    this.#discovery = discovery
    this.#runtime = this.options.runtimeCandidates.map(name => discovery.runtimes.find(runtime => runtime.name === name)).find(runtime => runtime !== undefined)
    return this
  }
}

export default RemoteTarget
export {RemoteTargetError} from './lib/remoteTarget/RemoteTargetError.ts'
export {LocalTargetTransport, SshTargetTransport, TargetTransport}
export type * from './lib/remoteTarget/types.ts'
export type {TransportChunkEvent, TransportChunkListener, TransportChunkStream, TransportCommand} from './lib/transport/base/TargetTransport.ts'

export type {SshTargetTransportOptions} from './lib/transport/SshTargetTransport.ts'
