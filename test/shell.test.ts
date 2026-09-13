import type {InvocationResult, SshShell, TransportCommandOptions} from '#src/lib/remoteTarget/types.ts'

import {expect, test} from 'bun:test'
import {tmpdir} from 'node:os'

import * as path from 'forward-slash-path'
import fs from 'fs-extra'

import {runProcess} from '#src/lib/remoteTarget/runProcess.ts'
import {encodeShellCommand, escapePosix} from '#src/lib/transport/encodeShellCommand.ts'
import {SshTargetTransport} from '#src/lib/transport/SshTargetTransport.ts'
import RemoteTarget from '#src/main.ts'

class ShellTransport extends SshTargetTransport {
  noRuntime = false
  readonly prefix: Array<string>
  constructor(prefix: Array<string>) {
    super({host: 'fixture'})
    this.prefix = prefix
  }
  getArgv() {
    return this.getSshBaseCommand()
  }
  override async runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult> {
    if (this.noRuntime && ['bun', 'node', 'deno'].includes(command[0]) && command[1] === '--version') {
      return {
        duration: 0,
        exitCode: 127,
        system: {pid: 0},
      }
    }
    return super.runShellNeutralCommand(command, options)
  }
  protected override runSsh(command: string, options: TransportCommandOptions) {
    return runProcess([...this.prefix, command], options)
  }
}
class VisibleSsh extends SshTargetTransport {
  getArgv() {
    return this.getSshBaseCommand()
  }
}
test('SSH destinations cannot become options and host-key paths retain spaces', () => {
  const transport = new VisibleSsh({
    host: '-oProxyCommand=bad',
    knownHostsFile: 'C:/path with spaces/known_hosts',
    sshConfigFile: 'C:/path with spaces/config',
    sshOptions: ['StrictHostKeyChecking=yes'],
  })
  const args = transport.getArgv()
  expect(args.at(-2)).toBe('--')
  expect(args.at(-1)).toBe('-oProxyCommand=bad')
  expect(args).toContain('UserKnownHostsFile="C:/path with spaces/known_hosts"')
  expect(args).toContain('GlobalKnownHostsFile=none')
  expect(args.indexOf('StrictHostKeyChecking=yes')).toBeLessThan(args.indexOf('StrictHostKeyChecking=accept-new'))
})
test('shell encoding rejects NUL and an empty executable', () => {
  expect(escapePosix`tool ${['a b', '', "can't"]}`).toBe("tool 'a b' '' 'can'\"'\"'t'")
  for (const shell of ['posix', 'fish', 'powershell', 'cmd'] as const) {
    expect(() => encodeShellCommand(['echo', '\0'], shell)).toThrow('NUL')
    expect(() => encodeShellCommand([''], shell)).toThrow('empty command')
  }
})
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh'
const shells: Array<{name: SshShell
  prefix: Array<string>
  probe: Array<string>}> = [
  {
    name: 'posix',
    prefix: [bash, '-c'],
    probe: [bash, '-c', 'exit 0'],
  },
  {
    name: 'powershell',
    prefix: ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    probe: ['pwsh', '-NoLogo', '-NoProfile', '-Command', 'exit 0'],
  },
  {
    name: 'cmd',
    prefix: ['cmd.exe', '/d', '/s', '/c'],
    probe: ['cmd.exe', '/d', '/c', 'exit 0'],
  },
  {
    name: 'fish',
    prefix: ['fish', '-c'],
    probe: ['fish', '-c', 'exit 0'],
  },
]
for (const shell of shells) {
  const probe = await runProcess(shell.probe, {
    timeoutMs: 5000,
    maxOutputBytes: 64_000,
  })
  const available = probe.exitCode === 0
  test.skipIf(!available)(`${shell.name}: real shell preserves spaced executable paths and complex argv`, async () => {
    const folder = path.enforceForwardSlashes(await fs.mkdtemp(path.join(tmpdir(), 'remote-target-shell-')))
    const file = path.join(folder, `runtime with spaces${process.platform === 'win32' ? '.exe' : ''}`)
    try {
      await fs.copyFile(process.execPath, file)
      if (process.platform !== 'win32') {
        await fs.chmod(file, 0o700)
      }
      const values = ['', 'hello world', "a'b", 'Don\u2019t', '"quoted"', '$HOME', '%PATH%', '\u0060tick\u0060', 'line\nbreak', 'x; echo INJECTED', '\u2192\u{1F9D9}']
      if (shell.name === 'fish') {
        values.push('\\', 'a\\', 'a\\b\\', "'", String.raw`\'`, '\\\\')
      }
      if (process.platform !== 'win32' || shell.name !== 'posix') {
        values.push('carriage\rreturn')
      }
      const transport = new ShellTransport(shell.prefix)
      const result = await transport.runShellNeutralCommand([file, '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', ...values], {timeoutMs: 10_000})
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout!)).toEqual(values)
      expect(transport.getShell()?.name).toBe(shell.name === 'posix' ? 'sh' : shell.name)
    } finally {
      await fs.rm(folder, {
        force: true,
        recursive: true,
      })
    }
  })
  test.skipIf(!available)(`${shell.name}: no-runtime exec uses the actual shell encoder`, async () => {
    const transport = new ShellTransport(shell.prefix)
    transport.noRuntime = true
    const target = new RemoteTarget('fixture', {transport})
    const result = await target.exec([process.execPath, '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', '', 'two words', "a'b", '\u2019'], {timeoutMs: 10_000})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout!)).toEqual(['', 'two words', "a'b", '\u2019'])
    expect(target.getDiscovery().runtimes).toEqual([])
  })
}
