import type {InvocationResult, RuntimeName, TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'

import {getRuntimeCommand} from '#src/lib/remoteTarget/discovery.ts'
import {ResultFrame} from '#src/lib/remoteTarget/ResultFrame.ts'
import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {deserializeTransportValue, serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
import {buildExecWrapper} from '#src/lib/remoteTarget/wrappers.ts'
import {TargetTransport} from '#src/lib/transport/base/TargetTransport.ts'
import {LocalTargetTransport} from '#src/lib/transport/LocalTargetTransport.ts'
import RemoteTarget, {RemoteTargetError} from '#src/main.ts'

class DelayedTransport extends TargetTransport {
  calls = 0
  delay = 150
  failures = 0
  readonly local = new LocalTargetTransport
  override runShellCommand(command: string, options?: TransportCommandOptions) {
    return this.local.runShellCommand(command, options)
  }
  override async runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult> {
    this.calls += 1
    if (this.calls === 1) {
      await Bun.sleep(this.delay)
    }
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('transient transport failure')
    }
    return this.local.runShellNeutralCommand(command, options)
  }
}
class DiscoveryTimeoutTransport extends TargetTransport {
  readonly commands: Array<Array<string>> = []

  override runShellCommand(): Promise<InvocationResult> {
    throw new Error('Unexpected shell command.')
  }

  override async runShellNeutralCommand(command: Array<string>): Promise<InvocationResult> {
    this.commands.push(command)
    return {
      duration: 1,
      exitCode: 124,
      failure: 'timeout',
      stderr: 'transport timed out',
      system: {pid: 0},
    }
  }
}
const createDelayed = () => {
  const transport = new DelayedTransport
  const target = new RemoteTarget('fixture', {transport})
  return {
    target,
    transport,
  }
}
test('already-aborted run, exec and init calls do not start discovery', async () => {
  const {target, transport} = createDelayed()
  const controller = new AbortController
  const reason = new Error('already canceled')
  controller.abort(reason)
  await expect(target.run('return 42', {signal: controller.signal})).rejects.toBe(reason)
  await expect(target.exec(['node', '--version'], {signal: controller.signal})).rejects.toBe(reason)
  await expect(target.init({signal: controller.signal})).rejects.toBe(reason)
  expect(transport.calls).toBe(0)
})
test('canceling one initialization waiter does not cancel other waiters', async () => {
  const {target} = createDelayed()
  const controller = new AbortController
  const reason = new Error('cancel one waiter')
  const first = target.init({signal: controller.signal})
  const second = target.init()
  controller.abort(reason)
  await expect(first).rejects.toBe(reason)
  await second
  expect(target.getDiscovery().runtimes.length).toBeGreaterThan(0)
})
test('a first invocation deadline includes initialization without poisoning the shared task', async () => {
  const {target} = createDelayed()
  await expect(target.run('return 42', {timeoutMs: 20})).rejects.toBeInstanceOf(RemoteTargetError)
  await target.init()
  const result = await target.run('return 42')
  expect(result.returnValue).toBe(42)
})
test('exec returns a structured initialization timeout', async () => {
  const {target} = createDelayed()
  const result = await target.exec(['node', '--version'], {timeoutMs: 20})
  expect(result.exitCode).toBe(124)
  expect(result.failure).toBe('timeout')
  await target.init()
})
test('exec rejects a transport timeout during discovery instead of claiming the command ran', async () => {
  const transport = new DiscoveryTimeoutTransport
  const target = new RemoteTarget('fixture', {transport})
  await expect(target.exec(['definitely-never-ran'])).rejects.toMatchObject({
    result: {
      exitCode: 124,
      failure: 'timeout',
      stderr: 'transport timed out',
    },
  })
  expect(transport.commands.some(command => command[0] === 'definitely-never-ran')).toBe(false)
})
test('runtime-backed exec lets the command timeout frame preserve partial output', async () => {
  const target = new RemoteTarget('fixture', {
    runtimeCandidates: ['bun'],
    transport: new LocalTargetTransport,
  })
  await target.init()
  const result = await target.exec([process.execPath, '--eval', 'process.stdout.write("started"); setTimeout(() => {}, 5000)'], {timeoutMs: 250})
  expect(result.exitCode).toBe(124)
  expect(result.failure).toBe('timeout')
  expect(result.stdout).toBe('started')
})
test('transient initialization failures can be retried', async () => {
  const {target, transport} = createDelayed()
  transport.failures = 1
  await expect(target.init()).rejects.toThrow('transient transport failure')
  await target.init()
  expect(target.getRuntime().file).toBeTruthy()
})
test('normalization consumes the deadline before an execution process is started', async () => {
  const {target, transport} = createDelayed()
  await target.init()
  const calls = transport.calls
  const source = `const value = ${JSON.stringify('x'.repeat(1_000_000))}; return value.length`
  await expect(target.run(source, {timeoutMs: 1})).rejects.toBeInstanceOf(RemoteTargetError)
  expect(transport.calls).toBe(calls)
})
const wireRoundTrip = (value: unknown) => {
  // The JSON boundary is the behavior under test; structuredClone would hide wire losses.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return deserializeTransportValue(JSON.parse(JSON.stringify(serializeTransportValue(value))) as unknown)
}
test('the JSON wire preserves Buffer, views, negative zero and sparse holes', () => {
  const sparse: Array<unknown> = []
  sparse.length = 3
  sparse[1] = undefined
  const original = {
    buffer: Buffer.from('hello'),
    zero: -0,
    sparse,
    view: new DataView(Uint8Array.from([1, 2, 3]).buffer, 1, 1),
    nan: Number.NaN,
  }
  const copy = wireRoundTrip(original) as typeof original
  expect(Buffer.isBuffer(copy.buffer)).toBe(true)
  expect(copy.buffer.toString()).toBe('hello')
  expect(Object.is(copy.zero, -0)).toBe(true)
  expect(copy.sparse.length).toBe(3)
  expect(0 in copy.sparse).toBe(false)
  expect(1 in copy.sparse).toBe(true)
  expect(2 in copy.sparse).toBe(false)
  expect(copy.view.getUint8(0)).toBe(2)
  expect(Number.isNaN(copy.nan)).toBe(true)
})
test('Float16Array support is capability-aware', () => {
  const scope = globalThis as {Float16Array?: new (buffer: ArrayBuffer) => ArrayBufferView}
  const Constructor = scope.Float16Array
  if (!Constructor) {
    return
  }
  const value = new Constructor(new Uint16Array([0x3C_00, 0xC0_00]).buffer)
  expect(wireRoundTrip(value)).toEqual(value)
  const encoded = serializeTransportValue(value)
  try {
    delete scope.Float16Array
    expect(() => deserializeTransportValue(encoded)).toThrow('not supported by the caller')
  } finally {
    scope.Float16Array = Constructor
  }
})
test('cycles, functions and shared-reference identity remain deliberately lossy', () => {
  const shared = {value: 1}
  const input: {a: typeof shared
    b: typeof shared
    fn: () => void
    self?: unknown} = {
    a: shared,
    b: shared,
    fn: () => {},
  }
  input.self = input
  const result = wireRoundTrip(input) as Record<string, unknown>
  expect(result.a).toEqual(result.b)
  expect(result.a).not.toBe(result.b)
  expect(result.self).toBe('[Circular]')
  expect(typeof result.fn).toBe('string')
})
for (const runtime of ['bun', 'node', 'deno'] as const satisfies Array<RuntimeName>) {
  const probe = await runProcess([runtime, '--version'], {
    timeoutMs: 2000,
    maxOutputBytes: 64_000,
  })
  const available = probe.exitCode === 0
  test.skipIf(!available)(`${runtime}: run output budgets exclude structured results`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    const result = await target.run('import {Buffer} from "node:buffer"; return {buffer: Buffer.from("hello"), zero: -0, sparse: Array(2), nested: new Map([["a", new Set([1])]])}', {maxOutputBytes: 0})
    const value = result.returnValue as {buffer: Buffer
      nested: Map<string, Set<number>>
      sparse: Array<unknown>
      zero: number}
    expect(value.buffer.toString()).toBe('hello')
    expect(Object.is(value.zero, -0)).toBe(true)
    expect(0 in value.sparse).toBe(false)
    expect(value.nested.get('a')).toEqual(new Set([1]))
    expect(result.stdout).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
  test.skipIf(!available)(`${runtime}: run failures retain diagnostics and status`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    await target.init()
    for (const entry of [
      {
        source: 'process.exitCode = 7; return 42',
        options: {},
        exitCode: 7,
        failure: undefined,
      },
      {
        source: 'console.log("before"); await new Promise(resolve => setTimeout(resolve, 5000)); return 42',
        options: {timeoutMs: 250},
        exitCode: 124,
        failure: 'timeout',
      },
      {
        source: 'console.log("abcdefghijkl"); return 42',
        options: {maxOutputBytes: 3},
        exitCode: 1,
        failure: 'output-limit',
      },
      {
        source: 'return "x".repeat(10000)',
        options: {maxResultBytes: 100},
        exitCode: 1,
        failure: 'protocol',
      },
    ] as const) {
      try {
        await target.run(entry.source, entry.options)
        throw new Error('Expected execution failure.')
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteTargetError)
        const failure = error as RemoteTargetError
        expect(failure.exitCode).toBe(entry.exitCode)
        expect(failure.result.failure).toBe(entry.failure)
        if (entry.failure) {
          expect(failure.stderr).toBeTruthy()
        }
      }
    }
    await expect(target.run('process.exit(0)')).rejects.toBeInstanceOf(RemoteTargetError)
    try {
      await target.run('process.stdout.write("partial"); throw new Error("boom")')
    } catch (error) {
      expect((error as RemoteTargetError).stdout).toBe('partial')
      expect(((error as Error).cause as Error).message).toBe('boom')
    }
  })
  test.skipIf(!available)(`${runtime}: generated exec uses the shared stdin-safe process runner`, async () => {
    const frame = new ResultFrame(1_000_000)
    const wrapper = buildExecWrapper(['node', '--eval', 'process.stdin.pipe(process.stdout)'], frame.marker, {
      stdin: 'hello\0\u2192',
      timeoutMs: 2000,
    })
    const invocation = await runProcess(getRuntimeCommand(runtime), {
      frame: frame.options(),
      stdin: wrapper,
      timeoutMs: 5000,
    })
    const payload = frame.read<{ok: boolean
      result: {exitCode: number
        stdout: string}}>(invocation, 'Generated exec failed.')
    expect(payload.result.exitCode).toBe(0)
    expect(payload.result.stdout).toBe('hello\0\u2192')
  })
}
class SyntheticTransport extends TargetTransport {
  override async runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    const emitter = this.createChunkEmitter(command, options)
    const chunk = Buffer.from('synthetic-shell')
    emitter.stdout(chunk)
    return {
      duration: 0,
      exitCode: 0,
      stdout: chunk.toString(),
      system: {pid: 0},
    }
  }

  override async runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    const emitter = this.createChunkEmitter(command, options)
    const stdout = Buffer.from('synthetic-out')
    const stderr = Buffer.from('synthetic-err')
    emitter.stdout(stdout)
    emitter.stderr(stderr)
    return {
      duration: 0,
      exitCode: 0,
      stderr: stderr.toString(),
      stdout: stdout.toString(),
      system: {pid: 0},
    }
  }
}
class DerivedLocalTransport extends LocalTargetTransport {}
test('constructor accepts independent and built-in-derived transports', async () => {
  const independent = new SyntheticTransport
  const independentTarget = new RemoteTarget('synthetic', {transport: independent})
  expect(independentTarget.transport).toBe(independent)
  const directResult = await independentTarget.transport.runShellNeutralCommand(['synthetic', 'command'])
  expect(directResult.stdout).toBe('synthetic-out')
  const derived = new DerivedLocalTransport
  const derivedTarget = new RemoteTarget('derived-local', {
    runtimeCandidates: ['bun'],
    transport: derived,
  })
  const run = await derivedTarget.run('return 42')
  expect(derivedTarget.transport).toBe(derived)
  expect(run.returnValue).toBe(42)
})
test('transport chunk events and per-invocation callbacks identify concurrent-safe invocations', async () => {
  const transport = new SyntheticTransport
  const events: Array<{command: ReadonlyArray<string> | string
    invocationId: string
    stream: string
    text: string}> = []
  const callbackChunks: Array<string> = []
  const unsubscribeStdout = transport.on('stdout', event => {
    events.push({
      command: event.command,
      invocationId: event.invocationId,
      stream: event.stream,
      text: Buffer.from(event.chunk).toString(),
    })
  })
  const unsubscribeStderr = transport.on('stderr', event => {
    events.push({
      command: event.command,
      invocationId: event.invocationId,
      stream: event.stream,
      text: Buffer.from(event.chunk).toString(),
    })
  })
  try {
    await transport.runShellNeutralCommand(['demo', 'argument'], {
      onStderrChunk: chunk => callbackChunks.push(`stderr:${Buffer.from(chunk).toString()}`),
      onStdoutChunk: chunk => callbackChunks.push(`stdout:${Buffer.from(chunk).toString()}`),
    })
  } finally {
    unsubscribeStdout()
    unsubscribeStderr()
  }
  expect(callbackChunks).toEqual(['stdout:synthetic-out', 'stderr:synthetic-err'])
  expect(events.map(event => event.stream)).toEqual(['stdout', 'stderr'])
  expect(events.map(event => event.text)).toEqual(['synthetic-out', 'synthetic-err'])
  expect(events[0]?.command).toEqual(['demo', 'argument'])
  expect(events[1]?.invocationId).toBe(events[0]?.invocationId)
})
test('runtime-backed exec exposes live command stdout and stderr chunks', async () => {
  const transport = new LocalTargetTransport
  const target = new RemoteTarget('streaming-fixture', {
    runtimeCandidates: ['bun'],
    transport,
  })
  await target.init()
  const callbackStdout: Array<Buffer> = []
  const callbackStderr: Array<Buffer> = []
  const events: Array<{id: string
    stream: string
    text: string}> = []
  const offStdout = transport.on('stdout', event => {
    events.push({
      id: event.invocationId,
      stream: event.stream,
      text: Buffer.from(event.chunk).toString(),
    })
  })
  const offStderr = transport.on('stderr', event => {
    events.push({
      id: event.invocationId,
      stream: event.stream,
      text: Buffer.from(event.chunk).toString(),
    })
  })
  try {
    const result = await target.exec([process.execPath, '--eval', 'process.stdout.write("out"); process.stderr.write("err")'], {
      onStderrChunk: chunk => callbackStderr.push(Buffer.from(chunk)),
      onStdoutChunk: chunk => callbackStdout.push(Buffer.from(chunk)),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
  } finally {
    offStdout()
    offStderr()
  }
  expect(Buffer.concat(callbackStdout).toString()).toBe('out')
  expect(Buffer.concat(callbackStderr).toString()).toBe('err')
  expect(events.map(event => event.text).join('')).toContain('out')
  expect(events.map(event => event.text).join('')).toContain('err')
  expect(new Set(events.map(event => event.id)).size).toBe(1)
})
