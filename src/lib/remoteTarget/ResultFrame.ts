import type {InvocationResult, ProcessFailure, TransportCommandOptions} from './types.ts'

import {RemoteTargetError} from './RemoteTargetError.ts'
import {deserializeTransportValue} from './serialize.ts'

type Payload = {error?: unknown
  ok: boolean}

export const isInvocationResult = (value: unknown): value is InvocationResult => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Record<string, unknown>
  const system = result.system
  const failures: Array<ProcessFailure> = ['output-limit', 'protocol', 'signal', 'spawn', 'stdin', 'stream', 'timeout']
  return typeof result.duration === 'number' && Number.isFinite(result.duration) && result.duration >= 0
    && typeof result.exitCode === 'number' && Number.isInteger(result.exitCode)
    && (result.stdout === undefined || typeof result.stdout === 'string')
    && (result.stderr === undefined || typeof result.stderr === 'string')
    && (result.errorCode === undefined || typeof result.errorCode === 'string')
    && (result.failure === undefined || failures.includes(result.failure as ProcessFailure))
    && !!system && typeof system === 'object' && 'pid' in system && typeof system.pid === 'number' && Number.isInteger(system.pid) && system.pid >= 0
}

export class ResultFrame {
  readonly marker = `__remoteTarget_${crypto.randomUUID()}__`
  readonly maxBytes: number
  #error?: string
  #json?: string

  constructor(maxBytes = 16_000_000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxResultBytes must be a positive safe integer.')
    }
    this.maxBytes = maxBytes
  }

  options(): TransportCommandOptions['frame'] {
    return {
      marker: this.marker,
      maxBytes: this.maxBytes,
      onError: message => {
        this.#error = message
      },
      onFrame: json => {
        this.#json = json
      },
    }
  }

  read<Value extends Payload>(result: InvocationResult, purpose: string): Value {
    let payload: Value | undefined
    let cause: unknown
    if (this.#json !== undefined && !this.#error) {
      try {
        const parsed: unknown = JSON.parse(this.#json)
        if (!parsed || typeof parsed !== 'object' || !('ok' in parsed) || typeof parsed.ok !== 'boolean') {
          this.#error = 'Invalid result envelope.'
        } else {
          payload = parsed as Value
          if (!payload.ok && payload.error !== undefined) {
            cause = deserializeTransportValue(payload.error)
          }
        }
      } catch (error) {
        this.#error = 'Invalid JSON or value encoding in result frame.'
        cause = error
      }
    }
    if (result.exitCode !== 0 || !payload?.ok || this.#error) {
      const details = result.stderr?.trim()
      const protocol = this.#error ?? (payload ? undefined : 'Missing result frame.')
      throw new RemoteTargetError(`${purpose} Exit code: ${result.exitCode}.${details ? `\n${details}` : ''}${protocol ? `\n${protocol}` : ''}`, result, {cause})
    }
    return payload
  }
}
