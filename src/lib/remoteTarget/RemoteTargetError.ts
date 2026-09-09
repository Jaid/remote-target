import type {InvocationResult} from './types.ts'

export class RemoteTargetError extends Error {
  readonly result: InvocationResult

  constructor(message: string, result: InvocationResult, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteTargetError'
    this.result = result
  }

  get duration() {
    return this.result.duration
  }
  get exitCode() {
    return this.result.exitCode
  }
  get stderr() {
    return this.result.stderr
  }
  get stdout() {
    return this.result.stdout
  }
}
