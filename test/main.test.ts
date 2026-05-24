import {expect, test} from 'bun:test'

import {normalizeRunInput} from '#src/lib/remoteTarget/normalize.ts'
import {deserializeTransportValue, serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
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
  expect(normalized.normalizedCode).not.toContain('return typeof Bun')
})
test('normalizeRunInput keeps module exports intact', async () => {
  const normalized = await normalizeRunInput(`
    import os from 'node:os'
    export const platform: string = os.platform()
    export default 5552368
  `)
  expect(normalized.normalizedCode).toContain('export const platform = os.platform()')
  expect(normalized.normalizedCode).toContain('export default 5552368')
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
test('run local with explicit node runtime', async () => {
  const remoteTarget = new RemoteTarget('local', {
    runtimeCandidates: ['node'],
  })
  const result = await remoteTarget.run('export default typeof Bun')
  expect(result.exitCode).toBe(0)
  expect(result.runtime.name).toBe('node')
  expect(result.exports).toEqual({
    default: 'undefined',
  })
})
test('exec local preserves argv boundaries', async () => {
  const result = await RemoteTarget.exec('local', ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'hello world', 'two'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('["hello world","two"]\n')
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
})
