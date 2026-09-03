import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import makeArgv from 'make-argv'

import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'

type SshTargetTransportInput = {
  host: string
  keyFile?: string
  port?: number
  user?: string
}

export class SshTargetTransport extends TargetTransport {
  readonly destination: string
  readonly host: string
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

  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess([...this.getSshBaseCommand(), command], options)
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess([...this.getSshBaseCommand(), ...command], options)
  }

  private getSshBaseCommand() {
    return [
      'ssh',
      ...makeArgv({
        T: true,
        o: [
          'BatchMode=yes',
          'ConnectTimeout=10',
          'StrictHostKeyChecking=accept-new',
        ],
        p: this.port,
        i: this.keyFile || undefined,
      }, {keyStyle: false}),
      this.destination,
    ]
  }
}
