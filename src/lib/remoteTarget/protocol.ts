import type {InvocationResult, ProcessFailure, TransportCommandOptions, TransportResult} from './types.ts'

import {RemoteTargetError} from './RemoteTargetError.ts'
import {deserializeTransportValue} from './serialize.ts'

export const getProtocolOptions = (marker: string, maxBytes = 16_000_000): NonNullable<TransportCommandOptions['protocol']> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Expected maxResultBytes to be a non-negative safe integer.')
  }
  return {
    marker,
    maxBytes,
  }
}

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

export const readPayload = <T extends {error?: unknown
  ok: boolean}>(invocation: TransportResult, operation: string, host: string): {payload: T
  result: InvocationResult} => {
  const {protocol, ...result} = invocation
  let payload: T | undefined
  let frameError: unknown = protocol?.error ? new Error(protocol.error) : undefined
  try {
    if (protocol?.json === undefined) {
      throw new Error('Missing protocol frame.')
    }
    const value = JSON.parse(protocol.json) as unknown
    if (!value || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') {
      throw new TypeError('Malformed protocol payload.')
    }
    payload = value as T
  } catch (error) {
    frameError ??= error instanceof SyntaxError ? new Error('Invalid JSON in protocol frame.', {cause: error}) : error
  }
  let remoteError: unknown
  if (payload && !payload.ok) {
    try {
      remoteError = deserializeTransportValue(payload.error)
    } catch (error) {
      remoteError = error
    }
  }
  if (result.failure || result.exitCode !== 0 || payload && !payload.ok) {
    const message = operation === 'run' && payload && !payload.ok ? `Remote script execution failed on ${host}.` : `${operation}() failed on ${host} (${result.failure ?? `exit code ${result.exitCode}`}).`
    throw new RemoteTargetError(message, result, {cause: remoteError ?? frameError})
  }
  if (!payload || frameError) {
    throw new RemoteTargetError(`Invalid ${operation}() response from ${host}.`, result, {cause: frameError})
  }
  return {
    payload,
    result,
  }
}
