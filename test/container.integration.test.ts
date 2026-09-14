import type {InvocationResult, TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'

import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import RemoteTarget, {ContainerTransport} from '#src/main.ts'

const integration = process.env.REMOTE_TARGET_SKIP_INTEGRATION === '1' ? describe.skip : describe
const image = process.env.REMOTE_TARGET_CONTAINER_IMAGE ?? 'oven/bun:1.3.14'
class RecordingContainerTransport extends ContainerTransport {
  calls = 0
  protected override runContainer(command: Array<string>, options: TransportCommandOptions): Promise<InvocationResult> {
    this.calls += 1
    return super.runContainer(command, options)
  }
}
const docker = async (args: Array<string>, timeoutMs = 30_000) => {
  const result = await runProcess(['docker', ...args], {
    timeoutMs,
    maxOutputBytes: 1_000_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Docker fixture failed: ${args.join(' ')}\n${result.stderr ?? result.stdout}`)
  }
  return result.stdout?.trim() ?? ''
}
integration('real Docker container transport', () => {
  const containerName = `remote-target-container-${crypto.randomUUID()}`
  let containerId: string
  let transport: ContainerTransport
  let target: RemoteTarget
  beforeAll(async () => {
    await docker(['info', '--format', '{{.ServerVersion}}'])
    containerId = await docker(['run', '--detach', '--name', containerName, '--network', 'none', '--workdir', '/tmp', '--env', 'REMOTE_TARGET_CONTAINER_FIXTURE=yes', '--entrypoint', 'bun', image, '--eval', 'setInterval(() => {}, 1000)'], 120_000)
    transport = new ContainerTransport(containerId, {user: '1000:1000'})
    target = new RemoteTarget('mage-fixture', {
      transport,
      runtimeCandidates: ['bun'],
    })
    await target.init()
  }, {timeout: 150_000})
  afterAll(async () => {
    // This unique name belongs to this suite, even when setup failed after creating the container.
    const result = await runProcess(['docker', 'rm', '--force', containerName], {
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
    })
    if (result.exitCode !== 0 && !result.stderr?.includes('No such container')) {
      throw new Error(`Failed to remove owned container ${containerName}: ${result.stderr}`)
    }
  }, {timeout: 35_000})
  test('inherited Docker configuration reaches the same container by ID and name', async () => {
    for (const selected of [transport, new ContainerTransport(containerName)]) {
      const result = await selected.runShellNeutralCommand(['bun', '--eval', 'console.log(process.env.REMOTE_TARGET_CONTAINER_FIXTURE)'], {timeoutMs: 10_000})
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('yes\n')
    }
  }, 35_000)
  test('complete assumptions skip Docker discovery before a generated program', async () => {
    const assumedTransport = new RecordingContainerTransport(containerId, {user: '1000:1000'})
    const assumedTarget = new RemoteTarget('mage-assumed-fixture', {
      assumptions: {
        os: {
          name: 'linux',
          distribution: 'debian',
        },
        runtimes: [
          {
            file: 'bun',
            name: 'bun',
          },
        ],
        shell: {name: 'unknown'},
      },
      runtimeCandidates: ['bun'],
      transport: assumedTransport,
    })
    const result = await assumedTarget.run('return process.env.REMOTE_TARGET_CONTAINER_FIXTURE', {timeoutMs: 10_000})
    expect(result.returnValue).toBe('yes')
    expect(assumedTransport.calls).toBe(1)
  }, 15_000)
  test('discovery and generated stdin programs honor the container user, cwd and environment', async () => {
    expect(target.getDiscovery().os.name).toBe('linux')
    expect(target.getRuntime().name).toBe('bun')
    const result = await target.run('return {uid: process.getuid(), cwd: process.cwd(), value: process.env.REMOTE_TARGET_CONTAINER_FIXTURE, data: new Map([["answer", 42]])}', {timeoutMs: 10_000})
    expect(result.returnValue).toEqual({
      uid: 1000,
      cwd: '/tmp',
      value: 'yes',
      data: new Map([['answer', 42]]),
    })
  }, 15_000)
  test('direct exec preserves complex argv without a shell', async () => {
    const values = ['', 'two words', "a'b", '"quoted"', '$HOME', '%PATH%', '\u0060tick\u0060', 'line\nbreak', 'a\\', 'x; echo INJECTED', '\u2192\u{1F9D9}', '--user=root']
    const result = await transport.runShellNeutralCommand(['bun', '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', ...values], {timeoutMs: 10_000})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout!)).toEqual(values)
  }, 15_000)
  test('stdin round trips NUL, Unicode and empty input without a TTY', async () => {
    for (const stdin of ['', 'NUL\0\u2192\u{1F9D9}\n'.repeat(20_000)]) {
      const result = await transport.runShellNeutralCommand(['cat'], {
        stdin,
        requireStdinDelivery: true,
        timeoutMs: 10_000,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout ?? '').toBe(stdin)
    }
  }, 25_000)
  test('Mage-style direct runtime invocation does not interpret application protocol output', async () => {
    const result = await transport.runShellNeutralCommand([target.getRuntime().file, '-'], {
      stdin: 'process.stdout.write(Buffer.from("Mage protocol").toString("base64"))',
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(Buffer.from('Mage protocol').toString('base64'))
  }, 15_000)
  test('runtime-backed exec streams before completion and returns the same output', async () => {
    const ready = Promise.withResolvers<void>()
    const stdout: Array<Uint8Array> = []
    const stderr: Array<Uint8Array> = []
    const invocation = target.exec(['bun', '--eval', 'process.stdout.write("ready"); setTimeout(() => {process.stdout.write("done"); process.stderr.write("warning")}, 1000)'], {
      timeoutMs: 10_000,
      onStdoutChunk: chunk => {
        stdout.push(chunk)
        ready.resolve()
      },
      onStderrChunk: chunk => stderr.push(chunk),
    })
    await Promise.race([
      ready.promise, invocation.then(() => {
        throw new Error('Execution finished before streaming output.')
      }),
    ])
    expect(Buffer.concat(stdout).toString()).toBe('ready')
    const result = await invocation
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('readydone')
    expect(result.stderr).toBe('warning')
    expect(result.stdout).toBe(Buffer.concat(stdout).toString())
    expect(result.stderr).toBe(Buffer.concat(stderr).toString())
  }, 15_000)
  test('shell calls, nonzero exits and output limits use the existing transport contracts', async () => {
    const shell = await transport.runShellCommand('printf hello; printf warning >&2; exit 7', {timeoutMs: 10_000})
    expect(shell.exitCode).toBe(7)
    expect(shell.stdout).toBe('hello')
    expect(shell.stderr).toBe('warning')
    const limited = await transport.runShellNeutralCommand(['bun', '--eval', 'process.stdout.write("123456789")'], {
      maxOutputBytes: 3,
      timeoutMs: 10_000,
    })
    expect(limited.failure).toBe('output-limit')
    expect(limited.stdout).toBe('123')
  }, 25_000)
  test('timeouts and cancellation bound the CLI without claiming container-process termination', async () => {
    // The remote sleepers are finite; the suite also removes its container in afterAll.
    const command = ['bun', '--eval', 'process.stdout.write("ready"); setTimeout(() => {}, 2000)']
    const timedOut = await transport.runShellNeutralCommand(command, {timeoutMs: 500})
    expect(timedOut.exitCode).toBe(124)
    expect(timedOut.failure).toBe('timeout')
    const controller = new AbortController
    const reason = new Error('cancel Docker exec')
    await expect(transport.runShellNeutralCommand(command, {
      signal: controller.signal,
      timeoutMs: 10_000,
      onStdoutChunk: () => controller.abort(reason),
    })).rejects.toBe(reason)
  }, 15_000)
})
