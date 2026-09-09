import type {RemoteTargetOptions, ShellInfo, SshShell, TransportCommandOptions, TransportResult} from '../remoteTarget/types.ts'

import makeArgv from 'make-argv'

import {InvocationDeadline} from '../remoteTarget/InvocationDeadline.ts'
import {RemoteTargetError} from '../remoteTarget/RemoteTargetError.ts'
import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'
import {encodeShellCommand} from './encodeShellCommand.ts'

type SshTargetTransportInput = Pick<RemoteTargetOptions, 'host' | 'keyFile' | 'knownHostsFile' | 'port' | 'sshConfigFile' | 'sshOptions' | 'sshShell' | 'strictHostKeyChecking' | 'user'>

export class SshTargetTransport extends TargetTransport {
  readonly destination: string
  readonly host: string
  readonly keyFile?: string
  readonly port?: number
  readonly user?: string
  readonly #options: SshTargetTransportInput
  #shell?: SshShell
  #shellPromise?: Promise<SshShell>

  constructor(options: SshTargetTransportInput) {
    super()
    this.#options = options
    this.destination = options.user ? `${options.user}@${options.host}` : options.host
    this.host = options.host
    this.keyFile = options.keyFile
    this.port = options.port
    this.user = options.user
    if (options.sshShell !== undefined && !['posix', 'powershell', 'fish', 'cmd'].includes(options.sshShell)) {
      throw new TypeError(`Unsupported SSH shell: ${String(options.sshShell)}`)
    }
    this.#shell = options.sshShell
  }

  override getShell(): ShellInfo | undefined {
    return this.#shell ? {name: this.#shell === 'posix' ? 'sh' : this.#shell} : undefined
  }

  protected getSshBaseCommand() {
    const knownHosts = this.#options.knownHostsFile
    return [
      'ssh',
      ...makeArgv({
        T: true,
        F: this.#options.sshConfigFile,
        o: [
          ...this.#options.sshOptions ?? [],
          'BatchMode=yes',
          'ConnectTimeout=10',
          `StrictHostKeyChecking=${this.#options.strictHostKeyChecking ?? 'accept-new'}`,
          ...knownHosts ? [`UserKnownHostsFile="${knownHosts.replaceAll('\\', '/').replaceAll('"', String.raw`\"`)}"`, 'GlobalKnownHostsFile=none'] : [],
        ],
        p: this.port,
        i: this.keyFile || undefined,
      }, {keyStyle: false}),
      '--',
      this.destination,
    ]
  }

  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<TransportResult> {
    return this.runSsh(command, options)
  }

  override async runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<TransportResult> {
    const deadline = new InvocationDeadline(options)
    if (!command[0] || command.some(argument => argument.includes('\0'))) {
      throw new TypeError('Expected a non-empty command without NUL arguments.')
    }
    const shell = this.#shell ?? await deadline.wait(this.resolveShell())
    const source = encodeShellCommand(command, shell)
    const result = await this.runShellCommand(source, {
      ...options,
      ...deadline.options(),
    })
    return {
      ...result,
      duration: deadline.elapsed,
    }
  }

  protected runSsh(command: string, options: TransportCommandOptions): Promise<TransportResult> {
    return runProcess([...this.getSshBaseCommand(), command], options)
  }

  private async detectShell(): Promise<SshShell> {
    // Probe the interpreter actually selected by sshd, not executables that happen to be installed.
    // This shared probe has its own bound; cancellation of one waiter does not cancel another waiter.
    const deadline = new InvocationDeadline({timeoutMs: 15_000})
    const token = `remote_target_shell_${crypto.randomUUID().replaceAll('-', '')}`
    const probes: Array<[SshShell, string]> = [
      ['posix', `__remote_target_shell=${token}; printf '%s' "$__remote_target_shell"`],
      ['powershell', `[Console]::Out.Write('${token}')`],
      ['fish', `if set -q version; printf '%s' '${token}'; end`],
      ['cmd', `if defined ComSpec echo ${token}`],
    ]
    for (const [shell, command] of probes) {
      const result = await deadline.wait(this.runShellCommand(command, {
        ...deadline.options(),
        maxOutputBytes: 65_536,
      }))
      if (result.exitCode === 255 || result.exitCode === 124) {
        throw new RemoteTargetError('SSH failed while detecting the remote shell.', result)
      }
      if (result.exitCode === 0 && result.stdout?.includes(token)) {
        return shell
      }
    }
    throw new Error('Unsupported SSH login shell. Configure a POSIX-compatible shell, fish or PowerShell 7.3+, or set sshShell explicitly when automatic probing is blocked.')
  }

  private resolveShell() {
    this.#shellPromise ??= (async () => {
      try {
        const shell = await this.detectShell()
        this.#shell = shell
        return shell
      } catch (error) {
        this.#shellPromise = undefined
        throw error
      }
    })()
    return this.#shellPromise
  }
}
