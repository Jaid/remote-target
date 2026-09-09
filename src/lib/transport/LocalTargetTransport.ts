import type {TransportCommandOptions, TransportResult} from '../remoteTarget/types.ts'

import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'

export class LocalTargetTransport extends TargetTransport {
  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<TransportResult> {
    const shell = process.platform === 'win32' ? ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] : ['sh', '-c']
    return runProcess([...shell, command], options)
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<TransportResult> {
    return runProcess(command, options)
  }
}
