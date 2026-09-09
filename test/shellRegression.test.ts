import type {RemoteTargetOptions, TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'
import {copyFileSync, existsSync, linkSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {encodeShellCommand, escapePosix} from '#src/lib/transport/encodeShellCommand.ts'
import {SshTargetTransport} from '#src/lib/transport/SshTargetTransport.ts'
import RemoteTarget from '#src/main.ts'

const pwsh = Bun.which('pwsh')
let bash = Bun.which('sh')
if (process.platform === 'win32') {
  bash = existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : null
}
const argumentsToPreserve = ['', 'hello world', "can't", 'Don’t‘‚‛', '"double"', '$HOME', '`backtick`', '$(echo WRONG)', '; echo WRONG', 'C:\\folder\\tail\\', 'é € 日本語', 'line\nbreak']
class ShellTransport extends SshTargetTransport {
  readonly shell: string

  constructor(shell: string, options: Partial<RemoteTargetOptions> = {}) {
    super({
      host: 'fixture',
      ...options,
    })
    this.shell = shell
  }

  baseCommand() {
    return this.getSshBaseCommand()
  }

  override runSsh(command: string, options: TransportCommandOptions) {
    const args = this.shell === pwsh ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
    return runProcess([this.shell, ...args], options)
  }
}
const withSpacedExecutable = async (run: (file: string) => Promise<void>) => {
  const node = Bun.which('node')
  if (!node) {
    throw new Error('Node is required for shell regression tests.')
  }
  const folder = mkdtempSync(join(tmpdir(), 'remote-target executable '))
  const file = join(folder, process.platform === 'win32' ? 'node with spaces.exe' : 'node with spaces')
  try {
    try {
      linkSync(node, file)
    } catch {
      copyFileSync(node, file)
    }
    await run(file)
  } finally {
    rmSync(folder, {
      force: true,
      recursive: true,
    })
  }
}
test('POSIX template adapters come from escapers and preserve array arguments', () => {
  expect(escapePosix`tool ${['a b', '', "can't"]}`).toBe("tool 'a b' '' 'can'\"'\"'t'")
  expect(() => encodeShellCommand(['echo', '\0'], 'posix')).toThrow('NUL')
})
for (const [name, shell] of [['posix', bash], ['powershell', pwsh]] as const) {
  test.skipIf(!shell)(`${name}: SSH-style command strings preserve executable paths and argv`, async () => {
    await withSpacedExecutable(async file => {
      const transport = new ShellTransport(shell!)
      const values = name === 'powershell' ? [...argumentsToPreserve, 'carriage\rreturn'] : argumentsToPreserve
      const result = await transport.runShellNeutralCommand([file, '-e', 'console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 7', '--', ...values], {timeoutMs: 5000})
      expect(result.exitCode).toBe(7)
      expect(JSON.parse(result.stdout ?? '') as unknown).toEqual(values)
      expect(transport.getShell()?.name).toBe(name === 'posix' ? 'sh' : 'powershell')
    })
  }, 10_000)
}
test.skipIf(!pwsh)('no-runtime PowerShell exec fallback uses the same argv encoder', async () => {
  class NoRuntimeTransport extends ShellTransport {
    override async runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}) {
      if (['bun', 'node', 'deno'].includes(command[0] ?? '')) {
        return {
          duration: 0,
          exitCode: 127,
          system: {pid: 0},
        }
      }
      return super.runShellNeutralCommand(command, options)
    }
  }
  const transport = new NoRuntimeTransport(pwsh!, {sshShell: 'powershell'})
  const target = new RemoteTarget('fixture')
  Object.defineProperty(target, 'transport', {value: transport})
  const result = await target.exec([Bun.which('node')!, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...argumentsToPreserve], {timeoutMs: 5000})
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout ?? '') as unknown).toEqual(argumentsToPreserve)
})
test('SSH arguments isolate host-key files and terminate local option parsing', () => {
  const transport = new ShellTransport('unused', {
    host: '-not-an-option',
    keyFile: 'C:/private/key',
    knownHostsFile: 'C:/space here/known_hosts',
    sshConfigFile: 'C:/private/ssh_config',
    strictHostKeyChecking: 'yes',
  })
  const command = transport.baseCommand()
  expect(command.at(-2)).toBe('--')
  expect(command.at(-1)).toBe('-not-an-option')
  expect(command).toContain('UserKnownHostsFile="C:/space here/known_hosts"')
  expect(command).toContain('GlobalKnownHostsFile=none')
  expect(command).toContain('StrictHostKeyChecking=yes')
  expect(command).toContain('C:/private/ssh_config')
})
