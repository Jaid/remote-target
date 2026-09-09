import type {InvocationOptions, RuntimeName} from './types.ts'

import {runProcess} from './runProcess.ts'
import {serializeTransportValue} from './serialize.ts'
import {toJavaScriptLiteral} from './toJavaScriptLiteral.ts'

const prelude = (marker: string) => String.raw`
import {Buffer} from 'node:buffer'
import process from 'node:process'
const serializeTransportValue = ${serializeTransportValue.toString()}
const serializeRemoteError = error => serializeTransportValue(error instanceof Error ? error : new Error(String(error)))
const writeResult = process.stdout.write.bind(process.stdout)
const emit = async payload => {
  const json = JSON.stringify(payload)
  await new Promise((resolve, reject) => writeResult(${toJavaScriptLiteral(marker)} + json + '\n', error => error ? reject(error) : resolve()))
}
const reportFailure = async error => {
  try {
    await emit({ok: false, error: serializeRemoteError(error)})
  } catch {
    process.stderr.write(String(error) + '\n')
  }
}
`

export const buildExecWrapper = (command: Array<string>, marker: string, options: InvocationOptions = {}) => `
${prelude(marker)}
const runProcess = ${runProcess.toString()}
try {
  const result = await runProcess(${toJavaScriptLiteral(command)}, ${toJavaScriptLiteral({
    maxOutputBytes: options.maxOutputBytes,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
  })})
  await emit({ok: true, result})
} catch (error) {
  await reportFailure(error)
  throw error
}
`

export const buildRunWrapper = (normalizedCode: string, globals: Record<string, unknown>, marker: string, exportsKey: string, returnValueKey: string, runtimeName: RuntimeName) => `
${prelude(marker)}
const source = Buffer.from(${toJavaScriptLiteral(Buffer.from(normalizedCode).toString('base64'))}, 'base64')
// Node does not support blob: modules; Bun supports large modules more reliably through a blob URL.
const useBlob = ${runtimeName !== 'node'}
const moduleUrl = useBlob ? URL.createObjectURL(new Blob([source], {type: 'text/javascript;charset=utf-8'})) : 'data:text/javascript;base64,' + source.toString('base64')
const exportsKey = ${toJavaScriptLiteral(exportsKey)}
const returnValueKey = ${toJavaScriptLiteral(returnValueKey)}
Object.assign(globalThis, ${toJavaScriptLiteral(globals)})
delete globalThis[exportsKey]
delete globalThis[returnValueKey]
try {
  await import(moduleUrl)
  await emit({ok: true, exports: serializeTransportValue(globalThis[exportsKey]), returnValue: serializeTransportValue(globalThis[returnValueKey])})
} catch (error) {
  await reportFailure(error)
  throw error
} finally {
  if (useBlob) URL.revokeObjectURL(moduleUrl)
}
`
