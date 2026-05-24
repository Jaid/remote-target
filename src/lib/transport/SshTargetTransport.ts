import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import {TargetTransport} from './base/TargetTransport.ts'
import {runProcess} from '../remoteTarget/runProcess.ts'

type SshTargetTransportInput = {
  host: string
  keyFile?: string
  port?: number
  user?: string
}

export class SshTargetTransport extends TargetTransport {
  readonly destination: string
  readonly host: string
  id = 'ssh'
  readonly keyFile?: string
  readonly port?: number
  readonly user?: string

  constructor({host, keyFile, port, user}: SshTargetTransportInput) {
    super()
    this.destination = user ? `${user}@${host}` : host
    this.host = host
    this.keyFile = keyFile
    this.port = port
    this.user = user
  }

  override runShellCommand(command: string): Promise<InvocationResult> {
    return runProcess([...this.getSshBaseCommand(), command])
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess([...this.getSshBaseCommand(), ...command], {
      stdin: options.stdin,
    })
  }

  private getSshBaseCommand() {
    const command = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']
    if (this.port !== undefined) {
      command.push('-p', String(this.port))
    }
    if (this.keyFile) {
      command.push('-i', this.keyFile)
    }
    command.push(this.destination)
    return command
  }
}
