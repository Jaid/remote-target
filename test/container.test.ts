import type {ContainerTransportOptions, TransportChunkEvent, TransportCommandOptions} from '#src/main.ts'

import {expect, test} from 'bun:test'
import {fileURLToPath} from 'node:url'

import RemoteTarget, {ContainerTransport, TargetTransport} from '#src/main.ts'

const fixture = fileURLToPath(new URL('fixture/docker.mjs', import.meta.url))
const dockerCommand = (mode = 'record') => [process.execPath, fixture, mode]
const createTransport = (mode = 'record', options: Omit<ContainerTransportOptions, 'container'> = {}) => new ContainerTransport('fixture', {
  dockerCommand: dockerCommand(mode),
  ...options,
})
const record = async (transport: ContainerTransport, command: Array<string>, options?: TransportCommandOptions) => {
  const result = await transport.runShellNeutralCommand(command, options)
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout!) as {argv: Array<string>
    stdin: string}
}
class VisibleContainer extends ContainerTransport {
  getCommand() {
    return this.getDockerBaseCommand()
  }
}
test('container constructors accept IDs, names and option objects', () => {
  const transport = new VisibleContainer('abc123', {user: '1000:1000'})
  expect(transport).toBeInstanceOf(TargetTransport)
  expect(transport.container).toBe('abc123')
  expect(transport.user).toBe('1000:1000')
  expect(transport.getCommand()).toEqual(['docker'])
  expect(new ContainerTransport({
    container: 'mage-session',
    user: 'agent',
  }).user).toBe('agent')
})
test('Docker and shell prefixes are copied and remain subclassable', () => {
  const prefix = ['docker', '--context', 'nas']
  const shell = ['sh', '-c']
  const transport = new VisibleContainer('fixture', {
    dockerCommand: prefix,
    shellCommand: shell,
  })
  prefix.push('bad')
  shell.push('bad')
  expect(transport.getCommand()).toEqual(['docker', '--context', 'nas'])
  expect(transport.shellCommand).toEqual(['sh', '-c'])
  class CustomContainer extends ContainerTransport {
    getCommand() {
      return this.getDockerBaseCommand()
    }
    protected override getDockerBaseCommand() {
      return [...super.getDockerBaseCommand(), '--log-level', 'error']
    }
  }
  expect(new CustomContainer('fixture').getCommand()).toEqual(['docker', '--log-level', 'error'])
  expect(new VisibleContainer('fixture', {dockerCommand: 'C:/Docker Tools/docker.exe'}).getCommand()).toEqual(['C:/Docker Tools/docker.exe'])
})
test('container exec preserves literal argv and terminates Docker option parsing', async () => {
  const command = ['tool with spaces', '', 'two words', "a'b", '"quoted"', '$HOME', '%PATH%', '\u0060tick\u0060', 'x; echo INJECTED', 'line\nbreak', 'trailing\\', '\u2192\u{1F9D9}', '--user=root']
  const transport = new ContainerTransport('-not-a-docker-option', {
    dockerCommand: dockerCommand(),
    user: '1000:1000',
  })
  const result = await record(transport, command)
  expect(result.argv).toEqual(['exec', '--user', '1000:1000', '--', '-not-a-docker-option', ...command])
  expect(result.argv).not.toContain('--interactive')
  expect(result.argv).not.toContain('--tty')
  expect(result.stdin).toBe('')
})
for (const stdin of ['', 'hello\nworld', 'NUL\0allowed', '\u2192\u{1F9D9}'.repeat(30_000)]) {
  test(`stdin enables interactive mode, including empty input (${stdin.length} characters)`, async () => {
    const result = await record(createTransport(), ['bun', '-'], {
      stdin,
      requireStdinDelivery: true,
    })
    expect(result.argv).toEqual(['exec', '--interactive', '--', 'fixture', 'bun', '-'])
    expect(result.stdin).toBe(stdin)
  })
}
test('shell execution uses the container interpreter, not the caller OS', async () => {
  const transport = createTransport()
  const events: Array<TransportChunkEvent> = []
  transport.on('stdout', event => events.push(event))
  const command = 'printf hello && printf world'
  const result = await transport.runShellCommand(command)
  expect((JSON.parse(result.stdout!) as {argv: Array<string>}).argv).toEqual(['exec', '--', 'fixture', 'sh', '-c', command])
  expect(events.length).toBeGreaterThan(0)
  expect(events.every(event => event.command === command)).toBe(true)
  expect(new Set(events.map(event => event.invocationId)).size).toBe(1)
  const custom = createTransport('record', {shellCommand: ['pwsh', '-NoProfile', '-Command']})
  const customResult = await custom.runShellCommand('Write-Output hello')
  expect((JSON.parse(customResult.stdout!) as {argv: Array<string>}).argv).toEqual(['exec', '--', 'fixture', 'pwsh', '-NoProfile', '-Command', 'Write-Output hello'])
  const neutralResult = await record(custom, ['tool', 'literal'])
  expect(neutralResult.argv).toEqual(['exec', '--', 'fixture', 'tool', 'literal'])
})
test('invalid identifiers and command prefixes fail early', () => {
  for (const container of ['', '  ', 'bad\0id']) {
    expect(() => new ContainerTransport(container)).toThrow('container')
  }
  for (const command of [[], [''], ['tool', '\0']]) {
    expect(() => new ContainerTransport('fixture', {dockerCommand: command})).toThrow('command')
    expect(() => new ContainerTransport('fixture', {shellCommand: command})).toThrow('command')
    expect(() => createTransport().runShellNeutralCommand(command)).toThrow('command')
  }
})
test('container framing strips protocol bytes from results, events and callbacks', async () => {
  const transport = createTransport('execute')
  const events: Array<TransportChunkEvent> = []
  const stdout: Array<Uint8Array> = []
  const stderr: Array<Uint8Array> = []
  const frames: Array<string> = []
  const errors: Array<string> = []
  transport.on('stdout', event => events.push(event))
  transport.on('stderr', event => events.push(event))
  const output = 'before__container_frame__{"ok":true}\nafter'
  const command = [process.execPath, '--eval', `process.stdout.write(${JSON.stringify(output)}); process.stderr.write("warning")`]
  const result = await transport.runShellNeutralCommand(command, {
    frame: {
      marker: '__container_frame__',
      maxBytes: 1000,
      onFrame: frame => frames.push(frame),
      onError: error => errors.push(error),
    },
    onStdoutChunk: chunk => stdout.push(chunk),
    onStderrChunk: chunk => stderr.push(chunk),
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('beforeafter')
  expect(result.stderr).toBe('warning')
  expect(frames).toEqual(['{"ok":true}'])
  expect(errors).toEqual([])
  expect(Buffer.concat(stdout).toString()).toBe('beforeafter')
  expect(Buffer.concat(stderr).toString()).toBe('warning')
  expect(Buffer.concat(events.filter(event => event.stream === 'stdout').map(event => event.chunk)).toString()).toBe('beforeafter')
  expect(new Set(events.map(event => event.invocationId)).size).toBe(1)
  expect(events.every(event => JSON.stringify(event.command) === JSON.stringify(command))).toBe(true)
})
test('unframed output and nonzero container exit codes are preserved', async () => {
  const result = await createTransport('execute').runShellNeutralCommand([process.execPath, '--eval', 'process.stdout.write("__marker__{base64}"); process.stderr.write("diagnostic"); process.exitCode = 7'])
  expect(result.exitCode).toBe(7)
  expect(result.stdout).toBe('__marker__{base64}')
  expect(result.stderr).toBe('diagnostic')
})
test('output limits and missing Docker executables retain process failure details', async () => {
  const result = await createTransport('record').runShellNeutralCommand(['tool'], {maxOutputBytes: 3})
  expect(result.failure).toBe('output-limit')
  expect(Buffer.byteLength(result.stdout!)).toBe(3)
  const missing = await new ContainerTransport('fixture', {dockerCommand: `missing-docker-${crypto.randomUUID()}`}).runShellNeutralCommand(['tool'])
  expect(missing.failure).toBe('spawn')
  expect(missing.errorCode).toBe('ENOENT')
})
test('timeouts bound the Docker CLI and zero timeouts never spawn', async () => {
  const result = await createTransport('wait').runShellNeutralCommand(['tool'], {timeoutMs: 500})
  expect(result.failure).toBe('timeout')
  expect(result.exitCode).toBe(124)
  expect(result.stdout).toBe('ready')
  const zero = await createTransport('wait').runShellNeutralCommand(['tool'], {timeoutMs: 0})
  expect(zero.exitCode).toBe(124)
  expect(zero.system.pid).toBe(0)
})
test('cancellation rejects with the original reason, before or during execution', async () => {
  const reason = new Error('cancel this container invocation')
  await expect(createTransport().runShellNeutralCommand(['tool'], {signal: AbortSignal.abort(reason)})).rejects.toBe(reason)
  const controller = new AbortController
  await expect(createTransport('wait').runShellNeutralCommand(['tool'], {
    signal: controller.signal,
    timeoutMs: 5000,
    onStdoutChunk: () => controller.abort(reason),
  })).rejects.toBe(reason)
})
test('RemoteTarget discovers runtimes, runs stdin programs and executes through ContainerTransport', async () => {
  const transport = createTransport('execute')
  const target = new RemoteTarget('mage-session', {
    transport,
    runtimeCandidates: ['bun'],
  })
  await target.init()
  expect(target.getRuntime().name).toBe('bun')
  const result = await target.run('console.log("hello"); return new Map([["answer", 42]])')
  expect(result.returnValue).toEqual(new Map([['answer', 42]]))
  expect(result.stdout).toBe('hello\n')
  const chunks: Array<Uint8Array> = []
  const exec = await target.exec([process.execPath, '--eval', 'process.stdin.pipe(process.stdout)'], {
    stdin: 'Mage stdin',
    onStdoutChunk: chunk => chunks.push(chunk),
  })
  expect(exec.exitCode).toBe(0)
  expect(exec.stdout).toBe('Mage stdin')
  expect(Buffer.concat(chunks).toString()).toBe('Mage stdin')
}, 15_000)
test('RemoteTarget command fallback works without a container JavaScript runtime', async () => {
  const target = new RemoteTarget('minimal-container', {transport: new ContainerTransport('no-runtime', {dockerCommand: dockerCommand('execute')})})
  const values = ['', 'two words', '$HOME', '\u2192\u{1F9D9}']
  const result = await target.exec([process.execPath, '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', ...values])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout!)).toEqual(values)
  expect(target.getDiscovery().runtimes).toEqual([])
}, 15_000)
