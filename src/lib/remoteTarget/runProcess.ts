import type {InvocationResult, ProcessFailure, TransportCommandOptions} from './types.ts'

// All runtime dependencies belong inside this function: the same implementation is embedded in remote wrappers.
export async function runProcess(command: Array<string>, options: TransportCommandOptions = {}, environment?: Record<string, string | undefined>): Promise<InvocationResult> {
  const startedAt = performance.now()
  options.signal?.throwIfAborted()
  const [file, ...args] = command
  if (!file) {
    throw new TypeError('Cannot run an empty command.')
  }
  for (const [name, value] of Object.entries({
    maxOutputBytes: options.maxOutputBytes,
    timeoutMs: options.timeoutMs,
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || name === 'timeoutMs' && value > 2_147_483_647)) {
      throw new RangeError(`${name} must be a non-negative safe integer.`)
    }
  }
  if (options.timeoutMs === 0) {
    return {
      duration: performance.now() - startedAt,
      exitCode: 124,
      failure: 'timeout',
      stderr: 'Process timed out after 0 ms.',
      system: {pid: 0},
    }
  }
  const {spawn} = await import('node:child_process')
  const {Buffer} = await import('node:buffer')
  options.signal?.throwIfAborted()
  return new Promise<InvocationResult>((resolve, reject) => {
    const child = spawn(file, args, {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Array<Buffer> = []
    const stderrChunks: Array<Buffer> = []
    const diagnostics: Array<string> = []
    const timers = new Set<ReturnType<typeof setTimeout>>
    let outputBytes = 0
    let forcedExitCode: number | undefined
    let failure: ProcessFailure | undefined
    let errorCode: string | undefined
    let settled = false
    let aborted = false
    let terminating = false
    const frame = options.frame
    const marker = frame ? Buffer.from(frame.marker) : undefined
    let pending = Buffer.alloc(0)
    let inFrame = false
    let frameSeen = false
    let frameBytes = 0
    let frameChunks: Array<Buffer> = []
    let frameFailed = false
    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      timers.add(timer)
      return timer
    }
    const finish = (code: number | null) => {
      if (settled) {
        return
      }
      if (pending.length > 0) {
        // The lifecycle callbacks are installed only after all helpers are initialized.
        // eslint-disable-next-line typescript/no-use-before-define
        capture(stdoutChunks, pending, options.onStdoutChunk)
        pending = Buffer.alloc(0)
      }
      if (inFrame && !frameFailed) {
        frame?.onError('Truncated result frame.')
        failure ??= 'protocol'
        forcedExitCode ??= 1
      }
      settled = true
      for (const timer of timers) {
        clearTimeout(timer)
      }
      // eslint-disable-next-line typescript/no-use-before-define
      options.signal?.removeEventListener('abort', onAbort)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      if (aborted) {
        reject(options.signal?.reason)
        return
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8') + diagnostics.map(message => `\n${message}`).join('')
      resolve({
        ...failure ? {failure} : {},
        ...errorCode ? {errorCode} : {},
        duration: performance.now() - startedAt,
        exitCode: forcedExitCode ?? code ?? 1,
        stderr: stderr || undefined,
        stdout: stdout || undefined,
        system: {pid: child.pid ?? 0},
      })
    }
    const terminate = (code: number, message?: string, kind: ProcessFailure = 'signal', nativeCode?: string) => {
      if (settled || terminating) {
        return
      }
      terminating = true
      forcedExitCode ??= code
      failure ??= kind
      errorCode ??= nativeCode
      if (message) {
        diagnostics.push(message)
      }
      child.stdin.destroy()
      child.kill('SIGTERM')
      later(() => {
        child.kill('SIGKILL')
        later(() => finish(child.exitCode), 500)
      }, 500)
    }
    function onAbort() {
      aborted = true
      terminate(1)
    }
    function capture(target: Array<Buffer>, chunk: Buffer, onChunk?: (chunk: Uint8Array) => void) {
      if (settled) {
        return
      }
      const remaining = options.maxOutputBytes === undefined ? chunk.length : Math.max(0, options.maxOutputBytes - outputBytes)
      if (remaining > 0) {
        const captured = Buffer.from(chunk.subarray(0, remaining))
        target.push(captured)
        outputBytes += captured.length
        onChunk?.(captured)
      }
      if (chunk.length > remaining) {
        terminate(1, `Output exceeded the ${options.maxOutputBytes}-byte limit.`, 'output-limit')
      }
    }
    const failFrame = (message: string) => {
      if (!frameFailed) {
        frameFailed = true
        frameChunks = []
        frame?.onError(message)
        terminate(1, message, 'protocol')
      }
    }
    const captureFrame = (chunk: Buffer) => {
      frameBytes += chunk.length
      if (frame && frameBytes > frame.maxBytes) {
        failFrame(`Structured result exceeded the ${frame.maxBytes}-byte limit.`)
      }
      if (!frameFailed) {
        frameChunks.push(chunk)
      }
    }
    const captureStdout = (chunk: Buffer) => {
      if (!frame || !marker) {
        capture(stdoutChunks, chunk, options.onStdoutChunk)
        return
      }
      let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      pending = Buffer.alloc(0)
      while (data.length > 0) {
        if (inFrame) {
          const end = data.indexOf(10)
          captureFrame(end === -1 ? data : data.subarray(0, end))
          if (end === -1) {
            return
          }
          if (!frameFailed) {
            frame.onFrame(Buffer.concat(frameChunks).toString('utf8'))
          }
          frameChunks = []
          inFrame = false
          data = data.subarray(end + 1)
          continue
        }
        const start = data.indexOf(marker)
        if (start !== -1) {
          capture(stdoutChunks, data.subarray(0, start), options.onStdoutChunk)
          if (frameSeen) {
            failFrame('Duplicate result frame.')
          }
          frameSeen = true
          inFrame = true
          frameBytes = 0
          data = data.subarray(start + marker.length)
          continue
        }
        // Retain only a possible marker prefix, not an arbitrary trailing output buffer.
        let retained = Math.min(marker.length - 1, data.length)
        while (retained > 0 && !data.subarray(data.length - retained).equals(marker.subarray(0, retained))) {
          retained -= 1
        }
        capture(stdoutChunks, data.subarray(0, data.length - retained), options.onStdoutChunk)
        pending = retained === 0 ? Buffer.alloc(0) : Buffer.from(data.subarray(data.length - retained))
        return
      }
    }
    child.on('error', error => {
      if (!settled && !terminating) {
        terminate(1, String(error), 'spawn', (error as NodeJS.ErrnoException).code)
      }
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Closing unused stdin is normal for ordinary commands, but not for a generated program that must be delivered.
      if (!options.requireStdinDelivery && ['EPIPE', 'EOF', 'ECONNRESET'].includes(error.code ?? '')) {
        return
      }
      terminate(1, `Failed to deliver stdin: ${String(error)}`, 'stdin', error.code)
    })
    child.stdout.on('error', error => terminate(1, `Failed to read stdout: ${String(error)}`, 'stream'))
    child.stderr.on('error', error => terminate(1, `Failed to read stderr: ${String(error)}`, 'stream'))
    child.stdout.on('data', captureStdout)
    child.stderr.on('data', (chunk: Buffer) => capture(stderrChunks, chunk, options.onStderrChunk))
    child.once('close', code => finish(code))
    child.once('exit', () => {
      // Descendants can inherit output pipes after the immediate child exits.
      later(() => {
        if (!settled) {
          diagnostics.push('Process exited but its output streams did not close.')
          failure ??= 'stream'
          forcedExitCode ??= child.exitCode || 1
          finish(child.exitCode)
        }
      }, 1000)
    })
    options.signal?.addEventListener('abort', onAbort, {once: true})
    if (options.signal?.aborted) {
      onAbort()
    } else {
      if (options.timeoutMs !== undefined) {
        later(() => terminate(124, `Process timed out after ${options.timeoutMs} ms.`, 'timeout'), Math.max(0, options.timeoutMs - (performance.now() - startedAt)))
      }
      child.stdin.end(options.stdin)
    }
  })
}
