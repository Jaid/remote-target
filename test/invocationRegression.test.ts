import type {TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'

import {deserializeTransportValue, serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
import {LocalTargetTransport} from '#src/lib/transport/LocalTargetTransport.ts'
import RemoteTarget from '#src/main.ts'

class GatedTransport extends LocalTargetTransport {
  calls = 0
  readonly gate = Promise.withResolvers<void>()

  override async runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}) {
    this.calls += 1
    if (this.calls === 1) {
      await this.gate.promise
    }
    return super.runShellNeutralCommand(command, options)
  }
}
const withTransport = (transport: LocalTargetTransport) => {
  const target = new RemoteTarget('synthetic-remote', {runtimeCandidates: ['bun']})
  Object.defineProperty(target, 'transport', {value: transport})
  return target
}
test('an already-aborted run does not start discovery', async () => {
  const transport = new GatedTransport
  const target = withTransport(transport)
  const reason = new Error('already canceled')
  await expect(target.run('return 42', {signal: AbortSignal.abort(reason)})).rejects.toBe(reason)
  expect(transport.calls).toBe(0)
})
test('canceling one waiter does not cancel shared initialization', async () => {
  const transport = new GatedTransport
  const target = withTransport(transport)
  const controller = new AbortController
  const reason = new Error('only this invocation')
  const canceled = target.run('return 1', {signal: controller.signal})
  const survivor = target.init()
  controller.abort(reason)
  try {
    await expect(canceled).rejects.toBe(reason)
  } finally {
    transport.gate.resolve()
  }
  await survivor
  const before = transport.calls
  const result = await target.run('return 42')
  expect(result.returnValue).toBe(42)
  expect(transport.calls).toBe(before + 1)
})
test('the first invocation deadline includes waiting for initialization', async () => {
  const transport = new GatedTransport
  const target = withTransport(transport)
  const startedAt = performance.now()
  const pending = target.run('return 42', {timeoutMs: 30})
  try {
    await expect(pending).rejects.toMatchObject({
      result: {
        exitCode: 124,
        failure: 'timeout',
      },
    })
    expect(performance.now() - startedAt).toBeLessThan(500)
  } finally {
    transport.gate.resolve()
  }
  await target.init()
  const result = await target.run('return 42')
  expect(result.returnValue).toBe(42)
})
test('exec reports an initialization timeout as an invocation result', async () => {
  const transport = new GatedTransport
  const target = withTransport(transport)
  try {
    const result = await target.exec(['node', '--version'], {timeoutMs: 30})
    expect(result.exitCode).toBe(124)
    expect(result.failure).toBe('timeout')
  } finally {
    transport.gate.resolve()
  }
  await target.init()
})
for (const runtime of ['bun', 'node', 'deno'] as const) {
  test.skipIf(!Bun.which(runtime))(`${runtime}: run keeps protocol data outside the user output limit`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    const result = await target.run('return 42', {maxOutputBytes: 0})
    expect(result.returnValue).toBe(42)
    expect(result.stdout).toBeUndefined()
    expect(result.stderr).toBeUndefined()
  })
  test.skipIf(!Bun.which(runtime))(`${runtime}: a nonzero process exit cannot report successful run`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    await expect(target.run('process.stdout.write("partial"); process.exitCode = 7; return 42')).rejects.toMatchObject({
      result: {
        exitCode: 7,
        stdout: 'partial',
      },
    })
  })
  test.skipIf(!Bun.which(runtime))(`${runtime}: timeouts and output limits preserve their diagnostics`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    await target.init()
    await expect(target.run('process.stdout.write("started"); await new Promise(resolve => setTimeout(resolve, 5000))', {timeoutMs: 250})).rejects.toMatchObject({
      result: {
        exitCode: 124,
        failure: 'timeout',
        stdout: 'started',
      },
    })
    await expect(target.run('process.stdout.write("x".repeat(10000)); return 42', {maxOutputBytes: 100})).rejects.toMatchObject({
      result: {
        exitCode: 1,
        failure: 'output-limit',
        stdout: 'x'.repeat(100),
      },
    })
  })
  test.skipIf(!Bun.which(runtime))(`${runtime}: remote error causes survive the wire boundary`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    await expect(target.run('throw new Error("outer", {cause: new Error("inner")})')).rejects.toMatchObject({
      cause: {
        message: 'outer',
        cause: {message: 'inner'},
      },
    })
  })
  test.skipIf(!Bun.which(runtime))(`${runtime}: binary values, negative zero and holes survive run`, async () => {
    const target = new RemoteTarget('local', {runtimeCandidates: [runtime]})
    const result = await target.run('const holes = Array(3); holes[1] = undefined; return {buf: Buffer.from("hello"), negative: -0, holes}')
    const value = result.returnValue as {buf: Buffer
      holes: Array<unknown>
      negative: number}
    expect(Buffer.isBuffer(value.buf)).toBe(true)
    expect(value.buf.toString()).toBe('hello')
    expect(Object.is(value.negative, -0)).toBe(true)
    expect(value.holes.length).toBe(3)
    expect(Object.hasOwn(value.holes, 0)).toBe(false)
    expect(Object.hasOwn(value.holes, 1)).toBe(true)
    expect(Object.hasOwn(value.holes, 2)).toBe(false)
  })
}
test('JSON wire round trips preserve Float16Array when the caller supports it', () => {
  const Constructor = (globalThis as unknown as {Float16Array?: new (values: Array<number>) => ArrayBufferView}).Float16Array
  if (!Constructor) {
    const payload = {
      __remoteTargetEnvelope: {
        version: 1,
        type: 'typedArray',
        name: 'Float16Array',
        data: 'AAA=',
      },
    }
    expect(() => deserializeTransportValue(payload)).toThrow('not supported by the caller')
    return
  }
  const original = new Constructor([0, -0, 1.5, Infinity])
  // eslint-disable-next-line unicorn/prefer-structured-clone
  const copy = deserializeTransportValue(JSON.parse(JSON.stringify(serializeTransportValue(original))) as unknown)
  expect(copy).toEqual(original)
})
test('functions and cycles retain documented lossy representations', () => {
  const value: {fn: () => void
    self?: unknown} = {fn: function named() {}}
  value.self = value
  // eslint-disable-next-line unicorn/prefer-structured-clone
  const result = deserializeTransportValue(JSON.parse(JSON.stringify(serializeTransportValue(value))) as unknown)
  expect(result).toEqual({
    self: '[Circular]',
    fn: '[Function named]',
  })
})
