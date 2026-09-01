import type {InvocationResult, TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'

import {normalizeRunInput} from '#src/lib/remoteTarget/normalize.ts'
import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {deserializeTransportValue, serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
import {TargetTransport} from '#src/lib/transport/base/TargetTransport.ts'
import RemoteTarget from '#src/main.ts'

const createScriptWithExactByteLength = (targetByteLength: number) => {
  const prefix = 'const padding = '
  const suffix = '\nconst length = padding.length\nexport default length\nreturn length\n'
  const stringLiteralQuotesByteLength = 2
  const paddingLength = targetByteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix) - stringLiteralQuotesByteLength
  if (paddingLength <= 0) {
    throw new Error(`Expected a target byte length above ${Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + stringLiteralQuotesByteLength}.`)
  }
  const inputCode = `${prefix}${JSON.stringify('x'.repeat(paddingLength))}${suffix}`
  const inputBytes = Buffer.byteLength(inputCode)
  if (inputBytes !== targetByteLength) {
    throw new Error(`Expected a script with ${targetByteLength} bytes, got ${inputBytes}.`)
  }
  return {
    expectedLength: paddingLength,
    inputBytes,
    inputCode,
  }
}
test('constructor supports host string and extra options', () => {
  const remoteTarget = new RemoteTarget('vps', {
    globals: {
      password: 'correct horse battery staple',
    },
    runtimeCandidates: ['node'],
  })
  expect(remoteTarget.options.host).toBe('vps')
  expect(remoteTarget.options.globals).toEqual({
    password: 'correct horse battery staple',
  })
  expect(remoteTarget.options.runtimeCandidates).toEqual(['node'])
})
test('constructor supports options object', () => {
  const remoteTarget = new RemoteTarget({
    host: '10.0.0.22',
    keyFile: 'C:/Users/jaid/.ssh/id_lan',
    port: 2222,
    user: 'jaid',
  })
  expect(remoteTarget.options.host).toBe('10.0.0.22')
  expect(remoteTarget.options.keyFile).toBe('C:/Users/jaid/.ssh/id_lan')
  expect(remoteTarget.options.port).toBe(2222)
  expect(remoteTarget.options.user).toBe('jaid')
})
test('normalizeRunInput rewrites top-level return', async () => {
  const normalized = await normalizeRunInput('return typeof Bun')
  expect(normalized.hasReturnValue).toBe(true)
  expect(normalized.normalizedCode).toContain(normalized.returnValueKey)
  expect(normalized.normalizedCode).toContain('await (async () =>')
})
test('normalizeRunInput keeps module exports intact', async () => {
  const normalized = await normalizeRunInput(`
    import os from 'node:os'
    export const platform: string = os.platform()
    export default 5552368
  `)
  expect(normalized.normalizedCode).toContain('const platform = os.platform()')
  expect(normalized.normalizedCode).toContain(normalized.exportsKey)
})
test('normalizeRunInput turns final expression into return value', async () => {
  const normalized = await normalizeRunInput(`
    const base = 40
    base + 2
  `)
  expect(normalized.hasReturnValue).toBe(true)
  expect(normalized.normalizedCode).toContain(normalized.returnValueKey)
})
test('run local function with default runtime', async () => {
  const result = await RemoteTarget.run('local', () => ({
    envType: typeof process.env,
    platform: process.platform,
  }))
  expect(result.exitCode).toBe(0)
  expect(result.returnValue).toEqual({
    envType: 'object',
    platform: process.platform,
  })
  expect(['bun', 'deno', 'node']).toContain(result.runtime.name)
})
test('run local string with exports and top-level return', async () => {
  const result = await RemoteTarget.run('local', `
    import os from 'node:os'
    export const platform = os.platform()
    return platform
  `)
  expect(result.exitCode).toBe(0)
  expect(result.exports).toEqual({
    platform: process.platform,
  })
  expect(result.returnValue).toBe(process.platform)
})
test('run local very long script with bun runtime', async () => {
  const {expectedLength, inputBytes, inputCode} = createScriptWithExactByteLength(1_050_000)
  expect(inputBytes).toBeGreaterThanOrEqual(1_000_000)
  expect(inputBytes).toBeLessThanOrEqual(1_200_000)
  const result = await RemoteTarget.run('local', inputCode, {
    runtimeCandidates: ['bun'],
  })
  expect(result.exitCode).toBe(0)
  expect(result.runtime.name).toBe('bun')
  expect(Buffer.byteLength(result.inputCode)).toBe(inputBytes)
  expect(result.exports).toEqual({
    default: expectedLength,
  })
  expect(result.returnValue).toBe(expectedLength)
})
test('run local preserves maps and sets in exports and return values', async () => {
  const result = await RemoteTarget.run('local', `
    export const namedMap = new Map([['a', 1], ['b', 2]])
    export const namedSet = new Set(['x', 'y'])
    export default new Map([[1, new Set(['nested'])]])
    return new Set(['result'])
  `)
  expect(result.exitCode).toBe(0)
  expect(result.exports).toEqual({
    default: new Map([[1, new Set(['nested'])]]),
    namedMap: new Map([['a', 1], ['b', 2]]),
    namedSet: new Set(['x', 'y']),
  })
  expect(result.returnValue).toEqual(new Set(['result']))
})
test('serializeTransportValue source stays self-contained when rebound under another name', () => {
  const script = [
    `const reboundSerializeTransportValue = ${serializeTransportValue.toString()}`,
    'console.log(JSON.stringify(reboundSerializeTransportValue(new Map([[1, new Set([\'nested\'])]]))))',
  ].join('\n')
  const result = Bun.spawnSync(['bun', '--eval', script], {
    stdin: 'ignore',
    stderr: 'pipe',
    stdout: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  expect(Buffer.from(result.stderr).toString('utf8')).toBe('')
  const serializedValue = JSON.parse(Buffer.from(result.stdout).toString('utf8')) as unknown
  expect(deserializeTransportValue(serializedValue)).toEqual(new Map([[1, new Set(['nested'])]]))
})
test('run local surfaces remote errors', async () => {
  try {
    await RemoteTarget.run('local', `
      throw new Error('boom')
    `)
    throw new Error('Expected RemoteTarget.run() to throw.')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Remote script execution failed on local.')
    expect((error as Error & {cause?: unknown}).cause).toBeInstanceOf(Error)
    expect(((error as Error & {cause?: unknown}).cause as Error).message).toBe('boom')
  }
})
test('run local string with globals injection', async () => {
  const remoteTarget = new RemoteTarget('local', {
    globals: {
      secret: 'abc123',
    },
  })
  const result = await remoteTarget.run(`
    export default secret
  `)
  expect(result.exitCode).toBe(0)
  expect(result.exports).toEqual({
    default: 'abc123',
  })
})
test('run local string with structured globals injection', async () => {
  const remoteTarget = new RemoteTarget('local', {
    globals: {
      amount: 5n,
      double: (value: bigint) => value * 2n,
      lookup: new Map([['a', 3]]),
      pattern: /abc/iu,
      releasedAt: new Date('2024-01-02T03:04:05.000Z'),
      tags: new Set(['x', 'y']),
      website: new URL('https://example.com/demo'),
    },
  })
  const result = await remoteTarget.run(`
    export const href = website.href
    export const iso = releasedAt.toISOString()
    export const mapValue = lookup.get('a')
    export const matched = pattern.test('---AbC---')
    export const setValue = tags.has('x')
    return double(amount)
  `)
  expect(result.exitCode).toBe(0)
  expect(result.exports).toEqual({
    href: 'https://example.com/demo',
    iso: '2024-01-02T03:04:05.000Z',
    mapValue: 3,
    matched: true,
    setValue: true,
  })
  expect(result.returnValue).toBe(10n)
})
test('run local TSX without React', async () => {
  const result = await RemoteTarget.run('local', `
    export default <section className="demo">hello</section>
  `)
  expect(result.exitCode).toBe(0)
  expect(result.exports).toEqual({
    default: {
      props: {
        children: 'hello',
        className: 'demo',
      },
      type: 'section',
    },
  })
})
test('run local with explicit bun runtime', async () => {
  const remoteTarget = new RemoteTarget('local', {
    runtimeCandidates: ['bun'],
  })
  const result = await remoteTarget.run('export default typeof Bun')
  expect(result.exitCode).toBe(0)
  expect(result.runtime.name).toBe('bun')
  expect(result.exports).toEqual({
    default: 'object',
  })
})
test('exec local preserves argv boundaries', async () => {
  const result = await RemoteTarget.exec('local', [process.execPath, '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', 'hello world', 'two'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('["hello world","two"]\n')
})
test('top-level return terminates execution', async () => {
  const result = await RemoteTarget.run('local', 'return 1\nthrow new Error(\'continued\')')
  expect(result.returnValue).toBe(1)
})
test('conditional top-level return terminates execution', async () => {
  const result = await RemoteTarget.run('local', 'if (true) return 2\nreturn 3')
  expect(result.returnValue).toBe(2)
})
test('only the actual final expression becomes an implicit result', async () => {
  const normalized = await normalizeRunInput('1\nconst later = 2')
  expect(normalized.hasReturnValue).toBe(false)
})
test('module exports survive an early top-level return', async () => {
  const result = await RemoteTarget.run('local', 'export const value = 4\nreturn value\nthrow new Error(\'continued\')')
  expect(result.exports).toEqual({value: 4})
  expect(result.returnValue).toBe(4)
})
test('named exports preserve their final live value', async () => {
  const result = await RemoteTarget.run('local', 'export let value = 1\nvalue = 2')
  expect(result.exports).toEqual({value: 2})
})
test('JSX helper names do not collide with user bindings', async () => {
  const result = await RemoteTarget.run('local', 'const __remoteTargetJsx = 5\nconst __remoteTargetFragment = 6\nexport default <span>{__remoteTargetJsx + __remoteTargetFragment}</span>')
  expect(result.exports?.default).toEqual({
    props: {children: 11},
    type: 'span',
  })
})
test('structured transport values are collision-safe and preserve array views', () => {
  const collision = {
    __remoteTargetEnvelope: {
      data: 'user',
      type: 'date',
      version: 1,
    },
  }
  const values = [collision, Symbol.for('demo'), new DataView(Uint8Array.from([1, 2]).buffer), new BigInt64Array([1n, -2n]), new BigUint64Array([3n])]
  const roundTrip = deserializeTransportValue(serializeTransportValue(values)) as Array<unknown>
  expect(roundTrip[0]).toEqual(collision)
  expect(Symbol.keyFor(roundTrip[1] as symbol)).toBe('demo')
  expect([...new Uint8Array((roundTrip[2] as DataView).buffer)]).toEqual([1, 2])
  expect(roundTrip[3]).toEqual(new BigInt64Array([1n, -2n]))
  expect(roundTrip[4]).toEqual(new BigUint64Array([3n]))
})
test('runProcess decodes UTF-8 split across chunks', async () => {
  const code = 'process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 10)'
  const result = await runProcess([process.execPath, '--eval', code])
  expect(result.stdout).toBe('€')
})
test('exec returns a structured spawn failure', async () => {
  const result = await RemoteTarget.exec('local', [`missing-${crypto.randomUUID()}`])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Executable not found')
})
test('getRuntime throws before init', () => {
  const remoteTarget = new RemoteTarget('local')
  expect(() => remoteTarget.getRuntime()).toThrow('Runtime has not been resolved yet')
})
test('init resolves local discovery and getRuntime', async () => {
  const remoteTarget = new RemoteTarget('local', {
    runtimeCandidates: ['bun', 'node'],
  })
  await remoteTarget.init()
  const discovery = remoteTarget.getDiscovery()
  const runtime = remoteTarget.getRuntime()
  expect(discovery.runtimes.length).toBeGreaterThan(0)
  expect(runtime.name === 'bun' || runtime.name === 'node').toBe(true)
  expect(runtime.file).not.toBe(runtime.name)
})
test('initialization and negative runtime probing are memoized', async () => {
  class UnavailableTransport extends TargetTransport {
    calls = 0
    override async runShellCommand(): Promise<InvocationResult> {
      this.calls += 1
      return {
        duration: 0,
        exitCode: 1,
        system: {pid: 0},
      }
    }
    override async runShellNeutralCommand(_command: Array<string>, _options?: TransportCommandOptions): Promise<InvocationResult> {
      this.calls += 1
      return {
        duration: 0,
        exitCode: 1,
        system: {pid: 0},
      }
    }
  }
  const remoteTarget = new RemoteTarget('example.invalid')
  const transport = new UnavailableTransport
  Object.defineProperty(remoteTarget, 'transport', {value: transport})
  await Promise.all([remoteTarget.init(), remoteTarget.init(), remoteTarget.init()])
  expect(transport.calls).toBe(6)
  await remoteTarget.init()
  expect(transport.calls).toBe(6)
  await remoteTarget.exec(['missing'])
  expect(transport.calls).toBe(7)
})
