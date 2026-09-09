import type {InvocationResult, ShellInfo, TransportCommandOptions} from '../../remoteTarget/types.ts'

export abstract class TargetTransport {
  getShell(): ShellInfo | undefined {
    return undefined
  }

  abstract runShellCommand(command: string, options?: TransportCommandOptions): Promise<InvocationResult>
  abstract runShellNeutralCommand(command: Array<string>, options?: TransportCommandOptions): Promise<InvocationResult>
}
