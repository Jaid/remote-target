import type {InvocationResult} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'
import {tmpdir} from 'node:os'

import {getRuntimeCommand} from '#src/lib/remoteTarget/discovery.ts'
import {ResultFrame} from '#src/lib/remoteTarget/ResultFrame.ts'
import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
import {buildExecWrapper} from '#src/lib/remoteTarget/wrappers.ts'
import {RemoteTargetError} from '#src/main.ts'

const node = ['node', '--input-type=module', '-']
test('Node callers survive a child closing stdin during a large write', async () => {
  const source = `const runProcess = ${runProcess.toString()}; const result = await runProcess([process.execPath, "--eval", "process.exit(0)"], {stdin: "x".repeat(2000000), timeoutMs: 5000}); console.log(JSON.stringify(result))`
  const caller = await runProcess(node, {
    stdin: source,
    timeoutMs: 10_000,
  })
  expect(caller.exitCode).toBe(0)
  expect(caller.stderr).toBeUndefined()
  const result = JSON.parse(caller.stdout!) as InvocationResult
  expect([0, 1]).toContain(result.exitCode)
  if (result.exitCode !== 0) {
    expect(result.failure).toBe('stdin')
  }
})
for (const runtime of ['bun', 'node', 'deno'] as const) {
  test.skipIf(!Bun.which(runtime))(`${runtime}: generated exec tolerates the command closing stdin early`, async () => {
    const frame = new ResultFrame
    const wrapper = buildExecWrapper(['node', '--eval', 'process.exit(0)'], frame.marker, {
      stdin: 'x'.repeat(2_000_000),
      timeoutMs: 3000,
    })
    const result = await runProcess(getRuntimeCommand(runtime), {
      frame: frame.options(),
      stdin: wrapper,
      requireStdinDelivery: true,
      timeoutMs: 5000,
    })
    const payload = frame.read<{ok: boolean
      result: InvocationResult}>(result, 'Generated exec failed.')
    expect(payload.result.exitCode).toBe(0)
  }, 10_000)
}
test('required stdin delivery becomes a structured failure instead of an unhandled event', async () => {
  const result = await runProcess(['node', '--eval', 'process.exit(0)'], {
    stdin: 'x'.repeat(2_000_000),
    requireStdinDelivery: true,
    timeoutMs: 3000,
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.failure).toBe('stdin')
  expect(result.stderr).toContain('stdin')
})
const sourceUrl = new URL('../src/main.ts', import.meta.url).href
for (const caller of ['bun', 'node'] as const) {
  test.skipIf(!Bun.which(caller))(`${caller}: Babel plugins resolve with an unrelated working directory`, async () => {
    const source = `import RemoteTarget from ${JSON.stringify(sourceUrl)}; const result = await RemoteTarget.run('local', 'return 42', {runtimeCandidates: ['bun']}); console.log(result.returnValue)`
    const child = Bun.spawn([caller, '--input-type=module', '--eval', source], {
      cwd: tmpdir(),
      stderr: 'pipe',
      stdout: 'pipe',
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
test('stdin preserves bytes and UTF-8 across an actual child process', async () => {
  const input = 'hello\0\r\n\u2192\u{1F9D9}'.repeat(10_000)
  const result = await runProcess(['node', '--eval', 'const chunks=[]; process.stdin.on("data", chunk => chunks.push(chunk)); process.stdin.on("end", () => process.stdout.write(Buffer.concat(chunks)))'], {
    stdin: input,
    timeoutMs: 5000,
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(input)
})
test('spawn failure and a zero timeout return structured results', async () => {
  const missing = await runProcess([`missing-${crypto.randomUUID()}`], {timeoutMs: 2000})
  expect(missing.failure).toBe('spawn')
  expect(missing.exitCode).toBe(1)
  expect(missing.errorCode).toBe('ENOENT')
  const expired = await runProcess(node, {timeoutMs: 0})
  expect(expired.failure).toBe('timeout')
  expect(expired.system.pid).toBe(0)
})
test('cancellation retains its original reason and cleans up the process', async () => {
  const controller = new AbortController
  const reason = new Error('caller canceled')
  const promise = runProcess(node, {
    stdin: 'setInterval(() => {}, 1000)',
    signal: controller.signal,
  })
  const timer = setTimeout(() => controller.abort(reason), 100)
  try {
    await expect(promise).rejects.toBe(reason)
  } finally {
    clearTimeout(timer)
  }
})
test.skipIf(process.platform === 'win32')('SIGTERM-resistant children are escalated and reaped', async () => {
  const result = await runProcess(node, {
    stdin: 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
    timeoutMs: 500,
  })
  expect(result.stdout).toContain('ready')
  expect(result.failure).toBe('timeout')
  expect(result.duration).toBeLessThan(2500)
  expect(result.system.pid).toBeGreaterThan(0)
  expect(() => process.kill(result.system.pid, 0)).toThrow()
})
test.skipIf(process.platform === 'win32')('inherited pipes cannot hold an exited invocation open indefinitely', async () => {
  const source = 'import {spawn} from "node:child_process"; const child = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 10000)"], {stdio: ["ignore", process.stdout, process.stderr]}); console.log(child.pid); child.unref()'
  const result = await runProcess(node, {
    stdin: source,
    timeoutMs: 4000,
  })
  const pid = Number(result.stdout?.trim())
  try {
    expect(result.failure).toBe('stream')
    expect(result.duration).toBeLessThan(3000)
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
})
test('framing handles split markers and UTF-8 separately from user output', async () => {
  const frame = new ResultFrame(1000)
  const payload = {
    ok: true,
    value: '\u2192\u{1F9D9}',
  }
  const output = `before\u2192${frame.marker}${JSON.stringify(payload)}\nafter`
  const source = `for (const byte of Buffer.from(${JSON.stringify(output)})) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)) }`
  const result = await runProcess(node, {
    frame: frame.options(),
    stdin: source,
    timeoutMs: 5000,
    maxOutputBytes: Buffer.byteLength('before\u2192after'),
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('before\u2192after')
  expect(frame.read<{ok: boolean
    value: string}>(result, 'Framing failed.')).toEqual(payload)
})
test('an available error frame survives an output breach in the same chunk', async () => {
  const frame = new ResultFrame(10_000)
  const payload = {
    ok: false,
    error: serializeTransportValue(new Error('useful remote error')),
  }
  const source = `process.stdout.write(${JSON.stringify(`abcdef${frame.marker}${JSON.stringify(payload)}\n`)})`
  const result = await runProcess(node, {
    frame: frame.options(),
    stdin: source,
    timeoutMs: 5000,
    maxOutputBytes: 3,
  })
  expect(result.failure).toBe('output-limit')
  expect(result.stdout).toBe('abc')
  expect(result.stderr).toContain('Output exceeded')
  try {
    frame.read(result, 'Remote script execution failed.')
    throw new Error('Expected failure.')
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteTargetError)
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(((error as Error).cause as Error).message).toBe('useful remote error')
  }
})
for (const kind of ['missing', 'truncated', 'invalid', 'oversized'] as const) {
  test(`protocol diagnostics distinguish ${kind} frames`, async () => {
    const frame = new ResultFrame(1000)
    const outputs = {
      missing: 'plain output',
      truncated: `${frame.marker}{`,
      invalid: `${frame.marker}{oops}\n`,
      oversized: `${frame.marker}${JSON.stringify({
        ok: true,
        data: 'x'.repeat(2000),
      })}\n`,
    }
    const result = await runProcess(node, {
      frame: frame.options(),
      stdin: `process.stdout.write(${JSON.stringify(outputs[kind])})`,
      timeoutMs: 5000,
    })
    let message = ''
    try {
      frame.read(result, 'Protocol failed.')
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteTargetError)
      message = (error as Error).message
    }
    if (kind === 'oversized') {
      expect(result.failure).toBe('protocol')
      expect(message).toContain('Structured result exceeded')
    } else if (kind === 'truncated') {
      expect(message).toContain('Truncated result frame')
    } else if (kind === 'invalid') {
      expect(message).toContain('Invalid JSON')
    } else {
      expect(message).toContain('Missing result frame')
    }
  })
}
test('raw transport calls keep arbitrary base64 and marker-like stdout unchanged', async () => {
  const text = `${Buffer.from('Unicode \u2192\u{1F9D9}').toString('base64')}__remoteTargetRun_fake__`
  const result = await runProcess(node, {
    stdin: `process.stdout.write(${JSON.stringify(text)})`,
    timeoutMs: 5000,
  })
  expect(result.stdout).toBe(text)
})
