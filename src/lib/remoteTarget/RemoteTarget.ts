import type {TargetTransport} from '../transport/base/TargetTransport.ts'
import type {DiscoveryInfo, ExecResult, InvocationOptions, RemoteTargetConstructorOptions, RemoteTargetInput, RemoteTargetOptions, RunInput, RunInvocationOptions, RunResult, RuntimeInfo, RuntimeName} from './types.ts'

import optis from 'optis'

import {LocalTargetTransport} from '../transport/LocalTargetTransport.ts'
import {SshTargetTransport} from '../transport/SshTargetTransport.ts'
import {discoverTarget, discoverWithoutRuntime, getRuntimeCommand, probeBootstrapRuntime} from './discovery.ts'
import {normalizeRunInput} from './normalize.ts'
import {deserializeTransportValue, serializeTransportValue} from './serialize.ts'
import {toJavaScriptLiteral} from './toJavaScriptLiteral.ts'

const supportedRuntimeNames = ['bun', 'node', 'deno'] as const satisfies Array<RuntimeName>

type RunPayload = {
  error?: unknown
  exports?: unknown
  ok: boolean
  returnValue?: unknown
}

type ExecPayload = {
  error?: unknown
  ok: boolean
  result?: {
    duration: number
    exitCode: number
    stderr?: string
    stdout?: string
    system: {
      pid: number
    }
  }
}

const normalizeRuntimeCandidates = (value: Array<RuntimeName> | undefined) => {
  const candidates = Array.isArray(value) ? value : [...supportedRuntimeNames]
  const normalizedCandidates = [...new Set(candidates)]
  const invalidCandidate = normalizedCandidates.find(candidate => !supportedRuntimeNames.includes(candidate))
  if (invalidCandidate) {
    throw new Error(`Unsupported runtime candidate: ${String(invalidCandidate)}`)
  }
  return normalizedCandidates.length === 0 ? [...supportedRuntimeNames] : normalizedCandidates
}
const optionsSchema = optis({
  defaults: {
    globals: {},
    runtimeCandidates: [...supportedRuntimeNames] as Array<RuntimeName>,
  },
  normalizations: {
    globals: (value: Record<string, unknown> | undefined) => {
      return value ? {...value} : {}
    },
    host: (value: string) => value.trim(),
    keyFile: (value: string | undefined) => {
      return value ? value.replaceAll('\\', '/') : undefined
    },
    port: (value: number | string | undefined) => {
      return value === undefined ? undefined : Number(value)
    },
    runtimeCandidates: (value: Array<RuntimeName> | undefined) => normalizeRuntimeCandidates(value),
    user: (value: string | undefined) => value?.trim() || undefined,
  },
  optional: {
    keyFile: undefined as string | undefined,
    port: undefined as number | undefined,
    user: undefined as string | undefined,
  },
  required: {
    host: '',
  },
})
const quotePosix = (value: string) => {
  return `'${value.replaceAll('\'', '\'"\'"\'')}'`
}
const quotePowerShell = (value: string) => {
  return `'${value.replaceAll('\'', '\'\'')}'`
}
const serializationPrelude = `const serializeTransportValue = ${serializeTransportValue.toString()}
const serializeRemoteError = error => error instanceof Error ? serializeTransportValue(error) : serializeTransportValue(new Error(String(error)))`
const buildModuleUrlSetup = (normalizedCode: string, runtimeName: RuntimeName) => {
  const encodedModule = Buffer.from(normalizedCode, 'utf8').toString('base64')
  // Node does not support blob: ESM imports, while Bun chokes on sufficiently large data: URLs.
  const useBlobModuleUrl = runtimeName !== 'node'
  return String.raw`
${useBlobModuleUrl ? `import {Buffer} from 'node:buffer'
` : ''}const encodedModule = ${toJavaScriptLiteral(encodedModule)}
const useBlobModuleUrl = ${toJavaScriptLiteral(useBlobModuleUrl)}
const moduleUrl = useBlobModuleUrl
  ? URL.createObjectURL(new Blob([Buffer.from(encodedModule, 'base64')], {type: 'text/javascript;charset=utf-8'}))
  : 'data:text/javascript;base64,' + encodedModule
const revokeModuleUrl = () => {
  if (useBlobModuleUrl) {
    URL.revokeObjectURL(moduleUrl)
  }
}
`
}
const buildExecWrapper = (command: Array<string>, marker: string, options: InvocationOptions) => String.raw`
import {spawn} from 'node:child_process'
import {Buffer} from 'node:buffer'

${serializationPrelude}

const command = ${toJavaScriptLiteral(command)}
const marker = ${toJavaScriptLiteral(marker)}
const options = ${toJavaScriptLiteral({
  maxOutputBytes: options.maxOutputBytes,
  stdin: options.stdin,
  timeoutMs: options.timeoutMs,
})}
const startedAt = Date.now()

const emit = payload => console.log(marker + JSON.stringify(payload))

try {
  const [file, ...args] = command
  const child = spawn(file, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  let outputBytes = 0
  let forcedExitCode
  const capture = (target, chunk) => {
    const remainingBytes = options.maxOutputBytes === undefined ? chunk.byteLength : Math.max(0, options.maxOutputBytes - outputBytes)
    if (remainingBytes > 0) {
      target.push(chunk.subarray(0, remainingBytes))
      outputBytes += Math.min(chunk.byteLength, remainingBytes)
    }
    if (options.maxOutputBytes !== undefined && chunk.byteLength > remainingBytes && forcedExitCode === undefined) {
      forcedExitCode = 1
      stderrChunks.push(Buffer.from('\nOutput exceeded the ' + options.maxOutputBytes + '-byte limit.'))
      child.kill()
    }
  }
  child.stdout.on('data', chunk => {
    capture(stdoutChunks, chunk)
  })
  child.stderr.on('data', chunk => {
    capture(stderrChunks, chunk)
  })
  child.stdin.end(options.stdin)
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    forcedExitCode = 124
    stderrChunks.push(Buffer.from('\nProcess timed out after ' + options.timeoutMs + ' ms.'))
    child.kill()
  }, options.timeoutMs)
  const exitCode = await new Promise(resolve => {
    child.once('error', error => {
      stderrChunks.push(Buffer.from(String(error)))
      resolve(1)
    })
    child.once('close', code => {
      resolve(forcedExitCode ?? code ?? 1)
    })
  })
  if (timeout) clearTimeout(timeout)
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  emit({
    ok: true,
    result: {
      duration: Date.now() - startedAt,
      exitCode,
      ...(stderr.length === 0 ? {} : {stderr}),
      ...(stdout.length === 0 ? {} : {stdout}),
      system: {
        pid: child.pid ?? 0,
      },
    },
  })
} catch (error) {
  emit({
    error: serializeRemoteError(error),
    ok: false,
  })
}
`
const buildRunWrapper = (normalizedCode: string, globals: Record<string, unknown>, marker: string, exportsKey: string, returnValueKey: string, runtimeName: RuntimeName) => {
  return String.raw`
${buildModuleUrlSetup(normalizedCode, runtimeName)}
${serializationPrelude}

const marker = ${toJavaScriptLiteral(marker)}
const exportsKey = ${toJavaScriptLiteral(exportsKey)}
const returnValueKey = ${toJavaScriptLiteral(returnValueKey)}

const emit = payload => console.log(marker + JSON.stringify(payload))

Object.assign(globalThis, ${toJavaScriptLiteral(globals)})
delete globalThis[returnValueKey]
delete globalThis[exportsKey]

try {
  await import(moduleUrl)
  emit({
    exports: serializeTransportValue(globalThis[exportsKey]),
    ok: true,
    returnValue: serializeTransportValue(globalThis[returnValueKey]),
  })
} catch (error) {
  emit({
    error: serializeRemoteError(error),
    ok: false,
  })
  throw error
} finally {
  revokeModuleUrl()
}
`
}
const buildShellCommand = (command: Array<string>, usePowerShellQuoting: boolean) => {
  const quote = usePowerShellQuoting ? quotePowerShell : quotePosix
  return command.map(argument => quote(argument)).join(' ')
}
const parseMarkedJsonPayload = <PayloadGeneric extends {ok: boolean}>(stdout: string | undefined, marker: string) => {
  if (!stdout) {
    return {
      stdout,
    }
  }
  const markerStart = stdout.lastIndexOf(marker)
  if (markerStart === -1) {
    return {
      stdout,
    }
  }
  const markerEnd = stdout.indexOf('\n', markerStart)
  const markerLine = stdout.slice(markerStart + marker.length, markerEnd === -1 ? undefined : markerEnd).trimEnd()
  const cleanedStdout = `${stdout.slice(0, markerStart)}${markerEnd === -1 ? '' : stdout.slice(markerEnd + 1)}` || undefined
  return {
    payload: JSON.parse(markerLine) as PayloadGeneric,
    stdout: cleanedStdout,
  }
}
const selectRuntime = (runtimes: Array<RuntimeInfo>, candidates: Array<RuntimeName>) => {
  return candidates.map(candidate => runtimes.find(runtime => runtime.name === candidate)).find(Boolean)
}
const toRuntimeErrorMessage = (host: string, candidates: Array<RuntimeName>, availableRuntimes: Array<RuntimeInfo>) => {
  const availableRuntimeText = availableRuntimes.length === 0 ? 'none' : availableRuntimes.map(runtime => `${runtime.name}${runtime.version ? ` (${runtime.version})` : ''}`).join(', ')
  return `No compatible runtime found on ${host}. Requested candidates: ${candidates.join(', ')}. Available runtimes: ${availableRuntimeText}.`
}
const toTransport = (options: RemoteTargetOptions): TargetTransport => {
  return options.host === 'local' ? new LocalTargetTransport : new SshTargetTransport(options)
}

export class RemoteTarget {
  static exec(target: RemoteTargetInput, command: Array<string>, options?: RemoteTargetConstructorOptions, invocationOptions?: InvocationOptions) {
    return new RemoteTarget(target, options).exec(command, invocationOptions)
  }
  static run(target: RemoteTargetInput, input: RunInput, options?: RemoteTargetConstructorOptions, invocationOptions?: RunInvocationOptions) {
    return new RemoteTarget(target, options).run(input, invocationOptions)
  }

  readonly options: RemoteTargetOptions
  readonly transport: TargetTransport
  #bootstrapRuntime?: RuntimeInfo | null
  #bootstrapRuntimePromise?: Promise<RuntimeInfo | undefined>
  #discovery?: DiscoveryInfo
  #initializationPromise?: Promise<this>
  #runtime?: RuntimeInfo

  constructor(input: RemoteTargetInput, extraOptions: RemoteTargetConstructorOptions = {}) {
    const mergedOptions = typeof input === 'string' ? {
      host: input,
      ...extraOptions,
    } : {
      ...input,
      ...extraOptions,
    }
    this.options = optionsSchema.process(mergedOptions)
    if (this.options.host.length === 0) {
      throw new Error('Expected a non-empty host.')
    }
    this.transport = toTransport(this.options)
  }

  async exec(command: Array<string>, invocationOptions: InvocationOptions = {}): Promise<ExecResult> {
    if (command.length === 0) {
      throw new Error('Cannot execute an empty command.')
    }
    if (this.options.host === 'local') {
      const result = await this.transport.runShellNeutralCommand(command, invocationOptions)
      return {
        ...result,
        command,
      }
    }
    const bootstrapRuntime = await this.resolveBootstrapRuntime()
    if (!bootstrapRuntime) {
      await this.init()
      const shellName = this.#discovery?.shell.name === 'powershell' ? 'powershell' : 'bash'
      const fallbackResult = await this.transport.runShellCommand(buildShellCommand(command, shellName === 'powershell'), invocationOptions)
      return {
        ...fallbackResult,
        command,
      }
    }
    const marker = `__remoteTargetExec_${crypto.randomUUID()}__`
    const wrapper = buildExecWrapper(command, marker, invocationOptions)
    const invocation = await this.transport.runShellNeutralCommand(getRuntimeCommand(bootstrapRuntime), {
      signal: invocationOptions.signal,
      timeoutMs: invocationOptions.timeoutMs === undefined ? undefined : invocationOptions.timeoutMs + 1000,
      stdin: wrapper,
    })
    const parsed = parseMarkedJsonPayload<ExecPayload>(invocation.stdout, marker)
    if (!parsed.payload) {
      throw new Error(`Failed to parse exec() payload from ${this.options.host}.`)
    }
    if (!parsed.payload.ok || !parsed.payload.result) {
      throw new Error(`Failed to execute ${command[0]} on ${this.options.host}.`, {
        cause: deserializeTransportValue(parsed.payload.error),
      })
    }
    return {
      ...parsed.payload.result,
      command,
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

  async init() {
    if (!this.#initializationPromise) {
      this.#initializationPromise = (async () => {
        try {
          return await this.initialize()
        } catch (error) {
          this.#initializationPromise = undefined
          throw error
        }
      })()
    }
    return this.#initializationPromise
  }

  async run(input: RunInput, invocationOptions: RunInvocationOptions = {}): Promise<RunResult> {
    await this.init()
    const runtime = this.#runtime
    if (!runtime) {
      throw new Error(toRuntimeErrorMessage(this.options.host, this.options.runtimeCandidates, this.#discovery?.runtimes ?? []))
    }
    const normalizedInput = await normalizeRunInput(input)
    const marker = `__remoteTargetRun_${crypto.randomUUID()}__`
    const invocation = await this.transport.runShellNeutralCommand(getRuntimeCommand(runtime), {
      ...invocationOptions,
      stdin: buildRunWrapper(normalizedInput.normalizedCode, this.options.globals, marker, normalizedInput.exportsKey, normalizedInput.returnValueKey, runtime.name),
    })
    const parsed = parseMarkedJsonPayload<RunPayload>(invocation.stdout, marker)
    if (!parsed.payload) {
      throw new Error(`Failed to parse run() payload from ${this.options.host}.`)
    }
    if (!parsed.payload.ok) {
      throw new Error(`Remote script execution failed on ${this.options.host}.`, {
        cause: deserializeTransportValue(parsed.payload.error),
      })
    }
    return {
      ...invocation,
      exports: deserializeTransportValue(parsed.payload.exports) as Record<string, unknown> | undefined,
      inputCode: normalizedInput.inputCode,
      normalizedCode: normalizedInput.normalizedCode,
      returnValue: normalizedInput.hasReturnValue ? deserializeTransportValue(parsed.payload.returnValue) : undefined,
      runtime,
      stdout: parsed.stdout,
    }
  }

  private async initialize() {
    const bootstrapRuntime = await this.resolveBootstrapRuntime()
    this.#discovery = bootstrapRuntime ? await discoverTarget(this.transport, bootstrapRuntime) : await discoverWithoutRuntime(this.transport)
    this.#runtime = selectRuntime(this.#discovery.runtimes, this.options.runtimeCandidates)
    return this
  }

  private async resolveBootstrapRuntime() {
    if (this.#bootstrapRuntime !== undefined) {
      return this.#bootstrapRuntime ?? undefined
    }
    if (!this.#bootstrapRuntimePromise) {
      this.#bootstrapRuntimePromise = (async () => {
        try {
          const runtime = await probeBootstrapRuntime(this.transport)
          this.#bootstrapRuntime = runtime ?? null
          return runtime
        } catch (error) {
          this.#bootstrapRuntimePromise = undefined
          throw error
        }
      })()
    }
    return this.#bootstrapRuntimePromise
  }
}
