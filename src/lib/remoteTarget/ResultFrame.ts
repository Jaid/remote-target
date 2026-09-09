import type {InvocationResult, TransportCommandOptions} from './types.ts'

import {RemoteTargetError} from './RemoteTargetError.ts'
import {deserializeTransportValue} from './serialize.ts'

type Payload = {error?: unknown
  ok: boolean}

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
