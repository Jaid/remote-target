import {expect, test} from 'bun:test'
import {tmpdir} from 'node:os'

import {getRuntimeCommand} from '#src/lib/remoteTarget/discovery.ts'
import {ResultFrame} from '#src/lib/remoteTarget/ResultFrame.ts'
import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {buildExecWrapper} from '#src/lib/remoteTarget/wrappers.ts'
import {LocalTargetTransport} from '#src/lib/transport/LocalTargetTransport.ts'
import RemoteTarget from '#src/main.ts'

const callerUrl = new URL('../src/lib/remoteTarget/runProcess.ts', import.meta.url).href
const sourceUrl = new URL('../src/main.ts', import.meta.url).href
const runtimes = ['bun', 'node', 'deno'] as const
for (const runtime of runtimes) {
  test.skipIf(!Bun.which(runtime))(`${runtime}: generated exec runner tolerates early stdin closure`, async () => {
    const frame = new ResultFrame
    const code = buildExecWrapper(['node', '-e', 'process.exit(0)'], frame.marker, {
      stdin: 'x'.repeat(2_000_000),
      timeoutMs: 3000,
    })
    const result = await runProcess(getRuntimeCommand(runtime), {
      stdin: code,
      frame: frame.options(),
      timeoutMs: 5000,
      requireStdinDelivery: true,
    })
    const payload = frame.read<{ok: boolean
      result: {exitCode: number}}>(result, 'Generated runner failed.')
    expect(payload.result.exitCode).toBe(0)
  }, 10_000)
}
test.skipIf(!Bun.which('node'))('Node callers survive a child closing a large stdin pipe', async () => {
  const code = `import {runProcess} from ${JSON.stringify(callerUrl)}; const result = await runProcess([process.execPath, '-e', 'process.exit(0)'], {stdin: 'x'.repeat(2_000_000), timeoutMs: 3000}); console.log(result.exitCode)`
  const result = await runProcess(['node', '--input-type=module', '--eval', code], {timeoutMs: 5000})
  expect(result.exitCode).toBe(0)
  expect(result.stdout?.trim()).toBe('0')
  expect(result.stderr).toBeUndefined()
})
for (const caller of ['bun', 'node']) {
  test.skipIf(!Bun.which(caller))(`${caller}: Babel plugins resolve with an unrelated cwd`, async () => {
    const code = `import RemoteTarget from ${JSON.stringify(sourceUrl)}; const result = await RemoteTarget.run('local', 'return 42', {runtimeCandidates: ['bun']}); console.log(result.returnValue)`
    const child = Bun.spawn([caller, '--input-type=module', '--eval', code], {
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({
      exitCode,
      stdout: stdout.trim(),
      stderr,
    }).toEqual({
      exitCode: 0,
      stdout: '42',
      stderr: '',
    })
  }, 10_000)
}
test('required stdin delivery is a structured failure, not an unhandled event', async () => {
  const result = await runProcess(['node', '-e', 'process.exit(0)'], {
    stdin: 'x'.repeat(2_000_000),
    requireStdinDelivery: true,
    timeoutMs: 3000,
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.failure).toBe('stdin')
  expect(result.stderr).toContain('stdin')
})
test('framing works across every marker boundary and excludes the result from output accounting', async () => {
  const marker = '__test_frame__'
  for (let split = 1; split < marker.length; split += 1) {
    let json: string | undefined
    let error: string | undefined
    const code = String.raw`process.stdout.write('é' + ${JSON.stringify(marker.slice(0, split))}); setTimeout(() => process.stdout.write(${JSON.stringify(marker.slice(split))} + '{"ok":true}\n' + 'z'), 5)`
    const result = await runProcess([process.execPath, '--eval', code], {
      frame: {
        marker,
        maxBytes: 100,
        onFrame: value => {
          json = value
        },
        onError: value => {
          error = value
        },
      },
      maxOutputBytes: 3,
      timeoutMs: 1000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('éz')
    expect(json).toBe('{"ok":true}')
    expect(error).toBeUndefined()
  }
})
test('unfinished frame is distinguished from invalid JSON', async () => {
  for (const [text, expected] of [['{"ok":true', 'Truncated result frame'], ['not-json\n', 'Invalid JSON']]) {
    const frame = new ResultFrame
    const result = await runProcess([process.execPath, '--eval', `process.stdout.write(${JSON.stringify(frame.marker + text)})`], {
      frame: frame.options(),
      maxOutputBytes: 0,
    })
    expect(() => frame.read(result, 'Test failed.')).toThrow(expected)
  }
})
test('result size is bounded independently of stdout and stderr', async () => {
  const frame = new ResultFrame(100)
  const result = await runProcess([process.execPath, '--eval', `process.stdout.write(${JSON.stringify(frame.marker)} + 'x'.repeat(10000)); setTimeout(() => {}, 2000)`], {
    frame: frame.options(),
    maxOutputBytes: 0,
  })
  expect(result.failure).toBe('protocol')
  expect(result.stdout).toBeUndefined()
  expect(result.stderr).toContain('Structured result exceeded')
})
test('spawn failures retain a stable native error code', async () => {
  const result = await runProcess([`missing-${crypto.randomUUID()}`])
  expect(result.exitCode).toBe(1)
  expect(result.failure).toBe('spawn')
  expect(result.errorCode).toBe('ENOENT')
})
test('the public remote exec path uses the shared runner', async () => {
  const target = new RemoteTarget('synthetic-remote')
  Object.defineProperty(target, 'transport', {value: new LocalTargetTransport})
  const result = await target.exec(['node', '-e', 'process.stdout.write("done"); process.exit(7)'], {
    stdin: 'unused'.repeat(500_000),
    timeoutMs: 4000,
  })
  expect(result.exitCode).toBe(7)
  expect(result.stdout).toBe('done')
})
test.skipIf(process.platform === 'win32')('termination escalates when the child ignores SIGTERM', async () => {
  const startedAt = performance.now()
  const result = await runProcess([process.execPath, '--eval', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], {timeoutMs: 300})
  expect(result.stdout).toBe('ready\n')
  expect(result.failure).toBe('timeout')
  expect(result.exitCode).toBe(124)
  expect(performance.now() - startedAt).toBeLessThan(2500)
  expect(() => process.kill(result.system.pid, 0)).toThrow()
})
