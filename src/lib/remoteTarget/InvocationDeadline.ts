import type {InvocationOptions} from './types.ts'

import {RemoteTargetError} from './RemoteTargetError.ts'

export class InvocationDeadline {
  readonly #options: Pick<InvocationOptions, 'signal' | 'timeoutMs'>
  readonly #startedAt = performance.now()

  constructor(options: Pick<InvocationOptions, 'signal' | 'timeoutMs'> = {}) {
    this.#options = options
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2_147_483_647)) {
      throw new RangeError('timeoutMs must be an integer between 0 and 2147483647.')
    }
    this.check()
  }

  get elapsed() {
    return performance.now() - this.#startedAt
  }

  check() {
    this.#options.signal?.throwIfAborted()
    if (this.#options.timeoutMs !== undefined && this.elapsed >= this.#options.timeoutMs) {
      throw this.#timeoutError()
    }
  }

  options() {
    return {
      signal: this.#options.signal,
      timeoutMs: this.remaining(),
    }
  }

  remaining() {
    this.check()
    return this.#options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(this.#options.timeoutMs - this.elapsed))
  }

  async wait<Value>(promise: Promise<Value>): Promise<Value> {
    // Attach a rejection handler even when the deadline expired immediately after the work was started.
    // eslint-disable-next-line promise/prefer-await-to-then
    void promise.catch(() => {})
    this.check()
    const signal = this.#options.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      const result = await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal?.reason)
          signal?.addEventListener('abort', abort, {once: true})
          const remaining = this.remaining()
          if (remaining !== undefined) {
            timer = setTimeout(() => reject(this.#timeoutError()), remaining)
          }
          if (signal?.aborted) {
            abort()
          }
        }),
      ])
      this.check()
      return result
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (abort) {
        signal?.removeEventListener('abort', abort)
      }
    }
  }

  #timeoutError() {
    const message = `Invocation timed out after ${this.#options.timeoutMs} ms.`
    return new RemoteTargetError(message, {
      duration: this.elapsed,
      exitCode: 124,
      failure: 'timeout',
      stderr: message,
      system: {pid: 0},
    })
  }
}
