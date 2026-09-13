import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'

export class LocalTargetTransport extends TargetTransport {
  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    const shell = process.platform === 'win32' ? ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] : ['sh', '-c']
    return runProcess([...shell, command], this.createChunkEmitter(command, options).options)
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess(command, this.createChunkEmitter(command, options).options)
  }
}
