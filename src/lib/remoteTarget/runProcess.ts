import type {InvocationOptions, InvocationResult} from './types.ts'

import {spawn} from 'node:child_process'

const toOptionalText = (chunks: Array<Buffer>) => {
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
}

export const runProcess = async (command: Array<string>, options: InvocationOptions = {}): Promise<InvocationResult> => {
  const [file, ...args] = command
  if (!file) {
    throw new Error('Cannot run an empty command.')
  }
  if (options.signal?.aborted) {
    throw options.signal.reason
  }
  const startedAt = performance.now()
  const child = spawn(file, args, {
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutChunks: Array<Buffer> = []
  const stderrChunks: Array<Buffer> = []
  let outputBytes = 0
  let forcedExitCode: number | undefined
  const capture = (target: Array<Buffer>, chunk: Buffer) => {
    const remainingBytes = options.maxOutputBytes === undefined ? chunk.byteLength : Math.max(0, options.maxOutputBytes - outputBytes)
    if (remainingBytes > 0) {
      target.push(chunk.subarray(0, remainingBytes))
      outputBytes += Math.min(chunk.byteLength, remainingBytes)
    }
    if (options.maxOutputBytes !== undefined && chunk.byteLength > remainingBytes && forcedExitCode === undefined) {
      forcedExitCode = 1
      stderrChunks.push(Buffer.from(`\nOutput exceeded the ${options.maxOutputBytes}-byte limit.`))
      child.kill()
    }
  }
  child.stdout.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk))
  child.stderr.on('data', (chunk: Buffer) => capture(stderrChunks, chunk))
  child.stdin.end(options.stdin)
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    forcedExitCode = 124
    stderrChunks.push(Buffer.from(`\nProcess timed out after ${options.timeoutMs} ms.`))
    child.kill()
  }, options.timeoutMs)
  timeout?.unref()
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', error => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? error)
        return
      }
      stderrChunks.push(Buffer.from(String(error)))
      resolve(1)
    })
    child.once('close', code => resolve(forcedExitCode ?? code ?? 1))
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
  return {
    duration: performance.now() - startedAt,
    exitCode,
    stderr: toOptionalText(stderrChunks),
    stdout: toOptionalText(stdoutChunks),
    system: {pid: child.pid ?? 0},
  }
}
