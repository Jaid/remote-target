import type {InvocationResult, SshShell, TransportCommandOptions, WindowsSession} from '#src/lib/remoteTarget/types.ts'

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
  constructor(prefix: Array<string>, windowsSession?: WindowsSession) {
    super({
      host: 'fixture',
      windowsSession,
    })
    this.prefix = prefix
  }
  getArgv() {
    return this.getSshBaseCommand()
  }
  override async runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult> {
    if (this.noRuntime && ['bun', 'deno', 'node'].includes(command[0]) && command[1] === '--version') {
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
test('desktop session relay fits through cmd.exe', () => {
  const command = ['bun', '--eval', 'console.log(Bun.argv)', 'a b', '', '"quoted" & | < > ^ %PATH%']
  const encoded = encodeShellCommand(command, 'cmd', {desktopSession: true})
  expect(encoded.length).toBeLessThan(8191)
  expect(encoded).not.toMatch(/["%&<>^|]/u)
  expect(encodeShellCommand(command, 'posix', {desktopSession: true})).toBe(encodeShellCommand(command, 'posix'))
  expect(encodeShellCommand(command, 'fish', {desktopSession: true})).toBe(encodeShellCommand(command, 'fish'))
})
test('SSH transport rejects unknown Windows sessions', () => {
  expect(() => new SshTargetTransport({
    host: 'fixture',
    windowsSession: 'console' as WindowsSession,
  })).toThrow('Unsupported Windows session')
  expect(new SshTargetTransport({host: 'fixture'}).windowsSession).toBe('desktop')
})
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh'
const shells: Array<{
  name: SshShell
  prefix: Array<string>
  probe: Array<string>
}> = [
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
      const values = ['', 'hello world', "a'b", 'Don\u{2019}t', '"quoted"', '$HOME', '%PATH%', '\u{60}tick\u{60}', 'line\nbreak', 'x; echo INJECTED', '\u{2192}\u{1F9D9}']
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
    const result = await target.exec([process.execPath, '--eval', 'console.log(JSON.stringify(Bun.argv.slice(1)))', '', 'two words', "a'b", '\u{2019}'], {timeoutMs: 10_000})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout!)).toEqual(['', 'two words', "a'b", '\u{2019}'])
    expect(target.getDiscovery().runtimes).toEqual([])
  })
  test.skipIf(!available || !['cmd', 'powershell'].includes(shell.name))(`${shell.name}: desktop session relay preserves stdin, streams and exit code`, async () => {
    const script = 'const {execFileSync} = require("node:child_process"); const session = execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "(Get-Process -Id $PID).SessionId"]).toString().trim(); console.log(JSON.stringify({args: Bun.argv.slice(1), session, stdin: await Bun.stdin.text()})); console.error("warning \u{2192}"); process.exit(7)'
    const results = {} as Record<WindowsSession, InvocationResult>
    for (const windowsSession of ['desktop', 'ssh'] as const) {
      results[windowsSession] = await new ShellTransport(shell.prefix, windowsSession).runShellNeutralCommand([process.execPath, '--eval', script, '', 'two words'], {
        stdin: 'input \u{1F9D9}',
        timeoutMs: 30_000,
      })
    }
    for (const result of Object.values(results)) {
      expect(result.exitCode).toBe(7)
      expect(result.stderr).toBe('warning \u{2192}\n')
      const output = JSON.parse(result.stdout!) as {
        args: Array<string>
        stdin: string
      }
      expect(output.args).toEqual(['', 'two words'])
      expect(output.stdin).toBe('input \u{1F9D9}')
    }
    const sshSession = (JSON.parse(results.ssh.stdout!) as {session: string}).session
    const desktopSession = (JSON.parse(results.desktop.stdout!) as {session: string}).session
    if (sshSession !== '0') {
      expect(desktopSession).toBe(sshSession)
    }
  })
}
