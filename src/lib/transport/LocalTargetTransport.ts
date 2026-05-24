import type {InvocationResult, TransportCommandOptions} from '../remoteTarget/types.ts'

import {TargetTransport} from './base/TargetTransport.ts'
import {runProcess} from '../remoteTarget/runProcess.ts'

const windowsCommand = ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const unixCommand = ['sh', '-lc']

export class LocalTargetTransport extends TargetTransport {
  id = 'local'

  override runShellCommand(command: string): Promise<InvocationResult> {
    return runProcess(process.platform === 'win32' ? [...windowsCommand, command] : [...unixCommand, command])
  }

  override runShellNeutralCommand(command: Array<string>, options: TransportCommandOptions = {}): Promise<InvocationResult> {
    return runProcess(command, {
      stdin: options.stdin,
    })
  }
}
