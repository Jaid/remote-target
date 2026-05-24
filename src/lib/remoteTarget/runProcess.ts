import type {InvocationResult} from './types.ts'

import {spawn} from 'node:child_process'

type ProcessRunOptions = {
  env?: NodeJS.ProcessEnv
  stdin?: string
}

const toOptionalText = (value: string) => {
  return value.length === 0 ? undefined : value
}

export const runProcess = async (command: Array<string>, options: ProcessRunOptions = {}): Promise<InvocationResult> => {
  const [file, ...args] = command
  if (!file) {
    throw new Error('Cannot run an empty command.')
  }
  const startedAt = performance.now()
  const child = spawn(file, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin)
  } else {
    child.stdin.end()
  }
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      resolve(code ?? 1)
    })
  })
  return {
    duration: performance.now() - startedAt,
    exitCode,
    stderr: toOptionalText(stderr),
    stdout: toOptionalText(stdout),
    system: {
      pid: child.pid ?? 0,
    },
  }
}
