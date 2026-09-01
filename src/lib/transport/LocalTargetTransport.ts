import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import {runProcess} from '../remoteTarget/runProcess.ts'
import {TargetTransport} from './base/TargetTransport.ts'

const windowsCommand = ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const unixCommand = ['sh', '-lc']

export class LocalTargetTransport extends TargetTransport {
  override runShellCommand(command: string, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess(process.platform === 'win32' ? [...windowsCommand, command] : [...unixCommand, command], options)
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess(command, options)
  }
}
