import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'

const [mode, ...argv] = process.argv.slice(2)
if (mode === 'record') {
  process.stdout.write(JSON.stringify({argv, stdin: readFileSync(0, 'utf8')}))
} else if (mode === 'environment') {
  process.stdout.write(process.env.REMOTE_TARGET_DOCKER_CLIENT_TEST ?? '')
} else if (mode === 'wait') {
  process.stdout.write('ready')
  setInterval(() => {}, 1000)
} else if (mode === 'execute') {
  const separator = argv.indexOf('--')
  if (separator === -1 || !argv.includes('exec')) {
    throw new Error('Expected docker exec with an option terminator.')
  }
  const [container, executable, ...args] = argv.slice(separator + 1)
  if (container === 'no-runtime' && ['bun', 'node', 'deno'].includes(executable) && args[0] === '--version') {
    process.exit(127)
  }
  const child = spawn(executable, args, {stdio: [argv.includes('--interactive') ? 'inherit' : 'ignore', 'inherit', 'inherit']})
  child.on('error', () => process.exit(127))
  child.on('exit', code => process.exit(code ?? 1))
} else {
  throw new Error('Unknown Docker fixture mode: ' + mode)
}
