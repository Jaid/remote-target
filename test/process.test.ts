import type {InvocationResult} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'

import {readPayload} from '#src/lib/remoteTarget/protocol.ts'
import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {serializeTransportValue} from '#src/lib/remoteTarget/serialize.ts'
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
  const marker = `__frame_${crypto.randomUUID()}__`
  const payload = {
    ok: true,
    value: '\u2192\u{1F9D9}',
  }
  const output = `before\u2192${marker}${JSON.stringify(payload)}\nafter`
  const source = `for (const byte of Buffer.from(${JSON.stringify(output)})) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)) }`
  const result = await runProcess(node, {
    stdin: source,
    timeoutMs: 5000,
    maxOutputBytes: Buffer.byteLength('before\u2192after'),
    protocol: {
      marker,
      maxBytes: 1000,
    },
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('before\u2192after')
  expect(JSON.parse(result.protocol!.json!)).toEqual(payload)
})
test('an available error frame survives an output breach in the same chunk', async () => {
  const marker = `__frame_${crypto.randomUUID()}__`
  const payload = {
    ok: false,
    error: serializeTransportValue(new Error('useful remote error')),
  }
  const source = `process.stdout.write(${JSON.stringify(`abcdef${marker}${JSON.stringify(payload)}\n`)})`
  const result = await runProcess(node, {
    stdin: source,
    timeoutMs: 5000,
    maxOutputBytes: 3,
    protocol: {
      marker,
      maxBytes: 10_000,
    },
  })
  expect(result.failure).toBe('output-limit')
  expect(result.stdout).toBe('abc')
  expect(result.stderr).toContain('Output exceeded')
  try {
    readPayload(result, 'run', 'fixture')
    throw new Error('Expected failure.')
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteTargetError)
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(((error as Error).cause as Error).message).toBe('useful remote error')
  }
})
for (const kind of ['missing', 'truncated', 'invalid', 'oversized'] as const) {
  test(`protocol diagnostics distinguish ${kind} frames`, async () => {
    const marker = `__frame_${crypto.randomUUID()}__`
    const outputs = {
      missing: 'plain output',
      truncated: `${marker}{`,
      invalid: `${marker}{oops}\n`,
      oversized: `${marker + JSON.stringify({
        ok: true,
        data: 'x'.repeat(2000),
      })}\n`,
    }
    const output = outputs[kind]
    const result = await runProcess(node, {
      stdin: `process.stdout.write(${JSON.stringify(output)})`,
      timeoutMs: 5000,
      protocol: {
        marker,
        maxBytes: 1000,
      },
    })
    expect(() => readPayload(result, 'run', 'fixture')).toThrow(RemoteTargetError)
    if (kind === 'oversized') {
      expect(result.failure).toBe('protocol')
    }
    if (kind === 'truncated') {
      expect(result.protocol?.error).toContain('Truncated')
    }
    if (kind === 'invalid') {
      try {
        readPayload(result, 'run', 'fixture')
      } catch (error) {
        expect(((error as Error).cause as Error).message).toContain('Invalid JSON')
      }
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
  expect(result.protocol).toBeUndefined()
})
